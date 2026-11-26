import { DatabaseSync } from 'node:sqlite'
import { mkdirSync, chmodSync } from 'node:fs'
import { dirname } from 'node:path'
import { retainWebhookProtocol } from './webhook-schema.ts'
import type { Repositories, Trigger, TriggerDisposition, Thread, Ticket, Decision, OutboundMessage } from './vendor/dsh-core/index.ts'
import {RuntimeRevisions} from './runtime-revisions.ts'
// 8/9 are reserved for Webhook grants/continuations. Delegation must fence
// Webhook-only releases from reopening service-authorized delegated work.
export const DELEGATION_DB_SCHEMA=10
export const DELEGATED_GOALS_DB_SCHEMA=11
export const WORKFLOW_DB_SCHEMA=12
export const EVOLUTION_DB_SCHEMA=14
export const REFLECTION_DB_SCHEMA=15
export const WEBHOOK_REHEARSAL_DB_SCHEMA=16
export const GOAL_REPLACEMENT_DB_SCHEMA=17
export const ASYNC_WORKER_DB_SCHEMA=18
export const WORKER_INQUIRY_DB_SCHEMA=19
export const CHAT_RESULT_REVIEW_DB_SCHEMA=20
export const CHAT_INTERJECTION_DB_SCHEMA=21
export const WORKFLOW_COMMITMENTS_DB_SCHEMA=24
export const MAX_DB_SCHEMA=WORKFLOW_COMMITMENTS_DB_SCHEMA

export interface Job { id: string; kind: string; payload: unknown; state: string; attempts: number; nextAt: number }
export interface Delivery extends OutboundMessage { inquiryId?:string; inquiryReadback?:boolean; taskResult?:number; status: string; attempts: number; nextAt: number; error?: string }
export interface Run {
  ticketId: string; assignmentId: string; threadId?: string; cwd: string
  phase: 'idle' | 'starting' | 'running' | 'background' | 'interrupted' | 'uncertain' | 'human' | 'delivering' | 'merging'
  turnId?: string; prepared?:boolean; waitingForWriter?:boolean; error?: string; result?: string
  workspaceId?:string;workspaceMode?:import('./workspace.ts').GoalWorkspaceMode;workspaceSource?:import('./workspace.ts').WorkspaceSource
  failure?:import('./execution-failure.ts').ExecutionFailure
  toolsVersion?:number;toolsDigest?:string;model?:string;backendId?:string;backendKind?:string
  agentOptions?:import('./backend-config.ts').AgentOptions;migration?:string
  rebuild?:string
  webFetchReplay?:import('./backends/opencode-web-checkpoint.ts').WebBatchReplay
  workerId?:string;interactiveReserve?:boolean
}

/** All engine mutations and the work they schedule share one SQLite transaction. */
export class Store implements Repositories {
  readonly db: DatabaseSync
  readonly revisions:RuntimeRevisions
  bodyFilter?:(kind:string,id:string,value:any)=>any
  readonly recordObservers=new Map<string,(id:string,value:any,previous:any)=>void>()
  private depth = 0
  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
    this.db = new DatabaseSync(path)
    const version = Number(this.db.prepare('PRAGMA user_version').get()!.user_version)
    if (version > MAX_DB_SCHEMA) {
      this.db.close()
      throw new Error('Database is newer than this program. Use the matching version.')
    }
    if (version > 0 && version < 6) {
      this.db.close()
      throw new Error('Router scope migration required. Stop the host and run scope-migration preview/apply before opening this database.')
    }
    chmodSync(path, 0o600)
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000; PRAGMA secure_delete=ON')
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS records (kind TEXT, id TEXT, body TEXT NOT NULL, PRIMARY KEY(kind,id));
      CREATE INDEX IF NOT EXISTS chat_native_approval_page ON records(json_extract(body,'$.chat.conversationId'),json_extract(body,'$.createdAt') DESC,id DESC) WHERE kind='approval';
      CREATE INDEX IF NOT EXISTS chat_managed_approval_page ON records(json_extract(body,'$.actor.conversationId'),json_extract(body,'$.createdAt') DESC,id DESC) WHERE kind='chat-permission';
      CREATE INDEX IF NOT EXISTS chat_file_approval_page ON records(json_extract(body,'$.conversationId'),json_extract(body,'$.createdAt') DESC,id DESC) WHERE kind='chat-message' AND json_type(body,'$.fileReview')='object';
      CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, kind TEXT NOT NULL, payload TEXT NOT NULL,
        state TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0, next_at INTEGER NOT NULL DEFAULT 0, error TEXT);
      CREATE TABLE IF NOT EXISTS outbox (id TEXT PRIMARY KEY, body TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending',
        attempts INTEGER NOT NULL DEFAULT 0, next_at INTEGER NOT NULL DEFAULT 0, error TEXT);
      CREATE TABLE IF NOT EXISTS audit (seq INTEGER PRIMARY KEY, at TEXT NOT NULL, body TEXT NOT NULL);
      -- Valid-JSON partial index also upgrades existing databases on open. The
      -- equality prefix plus seq avoids per-task full audit scans and sorting.
      CREATE INDEX IF NOT EXISTS audit_trace_checkpoint ON audit (
        json_extract(body,'$.type'), json_extract(body,'$.schema'),
        json_extract(body,'$.ticketId'), json_extract(body,'$.stage'), seq DESC
      ) WHERE json_valid(body);
      CREATE VIRTUAL TABLE IF NOT EXISTS memory_search USING fts5(id UNINDEXED, body, tokenize='trigram');
      PRAGMA user_version=${Math.max(version,6)};
    `)
    this.ensureGoalReferences()
    this.revisions=this.atomic(()=>new RuntimeRevisions(this.db))
  }
  // Derived only from authoritative goal records. Triggers also cover restores,
  // direct maintenance writes and rollbacks within an existing transaction.
  private ensureGoalReferences(){
    this.atomic(()=>{
      if(this.db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='goal_reference'").get())return
      this.db.exec(`
        CREATE TABLE goal_reference(goal_id TEXT, kind TEXT, ref TEXT,
          PRIMARY KEY(goal_id,kind,ref)) WITHOUT ROWID;
        CREATE INDEX goal_reference_lookup ON goal_reference(kind,ref,goal_id);
        CREATE INDEX goal_receipt_anchor ON records(json_extract(body,'$.triggerId')) WHERE kind='goal-receipt';
        CREATE INDEX goal_receipt_goal ON records(json_extract(body,'$.goalId')) WHERE kind='goal-receipt';
        CREATE VIEW goal_reference_source AS
          SELECT r.id AS goal_id,'task' AS kind,t.value AS ref FROM records r,json_each(r.body,'$.taskIds') t
            WHERE r.kind='router-goal' AND t.type='text'
          UNION ALL SELECT id,'trigger',json_extract(body,'$.triggerId') FROM records WHERE kind='router-goal'
          UNION ALL SELECT id,'trigger',json_extract(body,'$.contract.triggerId') FROM records WHERE kind='router-goal';
        INSERT OR IGNORE INTO goal_reference SELECT DISTINCT * FROM goal_reference_source WHERE ref IS NOT NULL;
        CREATE TRIGGER goal_reference_insert AFTER INSERT ON records WHEN NEW.kind='router-goal' BEGIN
          DELETE FROM goal_reference WHERE goal_id=NEW.id;
          INSERT OR IGNORE INTO goal_reference SELECT DISTINCT * FROM goal_reference_source WHERE goal_id=NEW.id AND ref IS NOT NULL;
        END;
        CREATE TRIGGER goal_reference_update AFTER UPDATE ON records WHEN OLD.kind='router-goal' OR NEW.kind='router-goal' BEGIN
          DELETE FROM goal_reference WHERE goal_id=OLD.id AND OLD.kind='router-goal';
          INSERT OR IGNORE INTO goal_reference SELECT DISTINCT * FROM goal_reference_source WHERE goal_id=NEW.id AND NEW.kind='router-goal' AND ref IS NOT NULL;
        END;
        CREATE TRIGGER goal_reference_delete AFTER DELETE ON records WHEN OLD.kind='router-goal' BEGIN
          DELETE FROM goal_reference WHERE goal_id=OLD.id;
        END;
      `)
    })
  }
  atomic<T>(work: () => T): T {
    const level = this.depth
    const savepoint = 'nested_' + level
    this.db.exec(level ? 'SAVEPOINT ' + savepoint : 'BEGIN IMMEDIATE')
    this.depth++
    try {
      const value = work()
      this.db.exec(level ? 'RELEASE ' + savepoint : 'COMMIT')
      return value
    } catch (error) {
      this.db.exec(level ? 'ROLLBACK TO ' + savepoint : 'ROLLBACK')
      if (level) this.db.exec('RELEASE ' + savepoint)
      throw error
    } finally { this.depth-- }
  }
  get<T>(kind: string, id: string): T | undefined {
    const row = this.db.prepare('SELECT body FROM records WHERE kind=? AND id=?').get(kind, id)
    return row ? JSON.parse(String(row.body)) as T : undefined
  }
  /** Older hosts cannot reconcile an input already claimed by the active Chat task. */
  requireChatInterjectionSchema(){this.db.exec('PRAGMA user_version='+Math.max(CHAT_INTERJECTION_DB_SCHEMA,Number(this.db.prepare('PRAGMA user_version').get()!.user_version)))}
  /** Older hosts cannot enforce pending result decisions or assignment-scoped Chat file reads. */
  requireChatResultReviewSchema(){this.db.exec('PRAGMA user_version='+Math.max(CHAT_RESULT_REVIEW_DB_SCHEMA,Number(this.db.prepare('PRAGMA user_version').get()!.user_version)))}
  requireWorkflowCommitmentsSchema(){
    retainWebhookProtocol(this.db)
    this.db.exec('PRAGMA user_version='+WORKFLOW_COMMITMENTS_DB_SCHEMA)
  }
  requireAsyncWorkerSchema(){this.db.exec('PRAGMA user_version='+Math.max(ASYNC_WORKER_DB_SCHEMA,Number(this.db.prepare('PRAGMA user_version').get()!.user_version)))}
  /** Older hosts would send a correlated result to the task creator instead of the asking message. */
  requireWorkerInquirySchema(){this.db.exec('PRAGMA user_version='+Math.max(WORKER_INQUIRY_DB_SCHEMA,Number(this.db.prepare('PRAGMA user_version').get()!.user_version)))}
  requireGoalReplacementSchema(){this.db.exec('PRAGMA user_version='+Math.max(GOAL_REPLACEMENT_DB_SCHEMA,Number(this.db.prepare('PRAGMA user_version').get()!.user_version)))}
  requireWorkflowSchema(){this.db.exec('PRAGMA user_version='+Math.max(WORKFLOW_DB_SCHEMA,Number(this.db.prepare('PRAGMA user_version').get()!.user_version)))}
  requireCodeProjectSchema(){this.db.exec('PRAGMA user_version='+Math.max(13,Number(this.db.prepare('PRAGMA user_version').get()!.user_version)))}
  requireEvolutionSchema(){this.db.exec('PRAGMA user_version='+Math.max(EVOLUTION_DB_SCHEMA,Number(this.db.prepare('PRAGMA user_version').get()!.user_version)))}
  /** Older releases cannot invalidate or erase the new derived memory copies. */
  requireReflectionSchema(){this.db.exec('PRAGMA user_version='+Math.max(REFLECTION_DB_SCHEMA,Number(this.db.prepare('PRAGMA user_version').get()!.user_version)))}
  prunePages(){this.db.prepare("DELETE FROM records WHERE kind='resource-page' AND id IN (SELECT id FROM records WHERE kind='resource-page' AND CAST(json_extract(body,'$.expires') AS INTEGER)<? LIMIT 1000)").run(Date.now())}
  put(kind: string, id: string, value: unknown): void {
    const observe=this.recordObservers.get(kind)
    if(observe&&!this.depth){this.atomic(()=>this.put(kind,id,value));return}
    const previous=observe?this.get(kind,id):undefined,filtered=this.bodyFilter?.(kind,id,value)??value
    this.db.prepare('INSERT INTO records VALUES(?,?,?) ON CONFLICT(kind,id) DO UPDATE SET body=excluded.body')
      .run(kind, id, JSON.stringify(filtered))
    observe?.(id,filtered,previous)
  }
  list<T>(kind: string): T[] {
    return this.db.prepare('SELECT body FROM records WHERE kind=? ORDER BY rowid').all(kind).map(row => JSON.parse(String(row.body)) as T)
  }
  readonly triggers = {
    get: (id: string) => this.get<Trigger>('trigger', id),
    save: (value: Trigger) => this.put('trigger', value.id, value),
    disposition: (id: string) => this.get<TriggerDisposition>('disposition', id),
    saveDisposition: (id: string, value: TriggerDisposition) => this.put('disposition', id, value),
  }
  readonly threads = {
    get: (id: string) => this.get<Thread>('thread', id),
    save: (value: Thread) => this.put('thread', value.key, value),
    list: () => this.list<Thread>('thread'),
    active: () => this.threads.list().filter(t => t.pending.length || t.evaluating),
  }
  readonly tickets = {
    get: (id: string) => this.get<Ticket>('ticket', id),
    save: (value: Ticket) => this.put('ticket', value.id, value),
    list: () => this.list<Ticket>('ticket').reverse(),
    open: () => this.tickets.list().filter(t => !t.ended),
    active: () => this.tickets.list().filter(t => t.undelivered.length || t.assignments.some(a => a.state !== 'ended')),
  }
  readonly decisions = {
    get: (id: string) => this.get<Decision>('decision', id),
    save: (value: Decision) => this.put('decision', value.id, value),
    byThread: (id: string) => this.list<Decision>('decision').filter(d => d.threadKey === id),
  }
  enqueue(id: string, kind: string, payload: unknown): void {
    const filtered=this.bodyFilter?.('job',id,payload)??payload
    this.db.prepare('INSERT OR IGNORE INTO jobs(id,kind,payload,state) VALUES(?,?,?,?)').run(id, kind, JSON.stringify(filtered),filtered===payload?'pending':'blocked')
  }
  jobs(): Job[] {
    return this.db.prepare("SELECT * FROM jobs WHERE state='pending' AND next_at<=? ORDER BY rowid").all(Date.now())
      .map(r => ({ id: String(r.id), kind: String(r.kind), payload: JSON.parse(String(r.payload)), state: String(r.state), attempts: Number(r.attempts), nextAt: Number(r.next_at) }))
  }
  jobState(id: string, state: string, error?: string): void {
    this.db.prepare('UPDATE jobs SET state=?,error=? WHERE id=?').run(state, error ?? null, id)
  }
  recoverJobs(): void {
    this.db.prepare("UPDATE jobs SET state=CASE WHEN kind='execute' THEN 'uncertain' ELSE 'pending' END WHERE state='running'").run()
  }
  recoverDeliveries():void {this.db.prepare("UPDATE outbox SET status='uncertain',error='Host stopped during delivery; reconcile destination before retry' WHERE status='sending'").run()}
  deliveryStarted(id:string):boolean{return this.db.prepare("UPDATE outbox SET status='sending' WHERE id=? AND status='pending'").run(id).changes===1}
  routePendingDelivery(id:string,channel:OutboundMessage['channel']):void{
    const row=this.db.prepare("SELECT body FROM outbox WHERE id=? AND status='pending'").get(id)
    if(row)this.db.prepare("UPDATE outbox SET body=? WHERE id=? AND status='pending'").run(JSON.stringify({...JSON.parse(String(row.body)),channel}),id)
  }
  readonly outbox = {
    send: (message: OutboundMessage) => { const filtered=this.bodyFilter?.('outbox',message.id,message)??message;this.db.prepare('INSERT OR IGNORE INTO outbox(id,body,status) VALUES(?,?,?)').run(message.id, JSON.stringify(filtered),filtered===message?'pending':'dropped') },
    status: (id: string) => {
      const r = this.db.prepare('SELECT status FROM outbox WHERE id=?').get(id)
      return r?.status === 'sent' ? 'sent' as const : r?.status === 'dropped' ? 'dropped' as const : r ? 'pending' as const : undefined
    },
    withdraw: (id: string) => { this.db.prepare("UPDATE outbox SET status='dropped' WHERE id=? AND status='pending'").run(id) },
  }
  deliveries(): Delivery[] {
    return this.db.prepare('SELECT * FROM outbox ORDER BY rowid').all().map(r => ({
      ...JSON.parse(String(r.body)), status: String(r.status), attempts: Number(r.attempts), nextAt: Number(r.next_at),
      ...(r.error ? { error: String(r.error) } : {}),
    }))
  }
  retryDelivery(id:string):void { this.db.prepare("UPDATE outbox SET status='pending',next_at=0 WHERE id=? AND status IN ('uncertain','pending')").run(id) }
  delivered(id: string): void { this.db.prepare("UPDATE outbox SET status='sent',error=NULL WHERE id=?").run(id) }
  deliveryFailed(id: string, attempts: number, error: string, uncertain = false): void {
    this.db.prepare('UPDATE outbox SET status=?,attempts=?,next_at=?,error=? WHERE id=?')
      .run(uncertain ? 'uncertain' : 'pending', attempts, Date.now() + Math.min(300_000, 1000 * 2 ** Math.min(attempts, 9)), error, id)
  }
  audit(body: unknown): void { this.db.prepare('INSERT INTO audit(at,body) VALUES(?,?)').run(new Date().toISOString(), JSON.stringify(this.bodyFilter?.('audit','',body)??body)) }
  close(): void { this.db.close() }
}
