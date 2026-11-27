import {browserCapacity} from './execution-limits.ts'
import {abortable} from './abortable.ts'
import { randomUUID, createHash } from "node:crypto";
import { mkdirSync, rmSync, chmodSync, realpathSync, writeFileSync, lstatSync } from "node:fs";
import { join } from "node:path";
import { evidenceBytes } from "./goal-artifacts.ts";
import type { Runtime } from "./runtime.ts";
import type { WorkOwner } from "./work.ts";
import { workerProfiles } from "./worker-pool.ts";
import type {BrowserInput} from "./browser-input.ts";
import { allowNewTaskInputs } from "./task-context.ts";
import type {ChatAttachment} from './chat-attachments.ts';
import {browserDownloads,browserDownload,browserUpload} from './browser-files.ts';
import {
  AgentBrowserDriver,
  type BrowserDriver,
  type DriverSession,
} from "./browser-driver.ts";
import { BrowserVault } from "./browser-vault.ts";
import { ManagedBrowserDriver } from "./managed-browser-driver.ts";
import { PageRecording, captureLimit } from "./browser-recording.ts";
import {
  BrowserError,
  browserAction,
  workspaceAction,
  browserUrl,
  type BrowserProfile,
  type BrowserProfileInput,
  type BrowserAction,
  type BrowserToolInput,
  type BrowserFrame,
  type BrowserActivity,
} from "./browser-contract.ts";

type Control = "worker" | "router" | "human" | "paused" | "handoff" | "ended";
interface Session extends DriverSession {
  user: string;
  profileId?: string;
  personal: boolean;
  workspace: boolean;
  owner?: WorkOwner;
  workerId?: string;
  conversationId?: string;
  control: Control;
  epoch: number;
  revision: number;
  client?: string;
  leaseUntil: number;
  ended: boolean;
  maxTabs: number;
  handoffReason?: string;
  routerTurn?: string;
  workspaceTicket?: string;
  routerConversation?: string;
  closing: boolean;
  tabs: { id: string; index: number; url: string; title: string; active?: boolean }[];
  url: string;
  title: string;
  updatedAt: number;
  watchers: Set<() => void>;
  ready: boolean;
  initialization?: Promise<void>;
  queue: Promise<unknown>;
  controller: AbortController;
  frame?: BrowserFrame;
  activity?: BrowserActivity;
  activityEpoch?: number;
  stopFrames?: () => void;
  startingFrames?: Promise<void>;
  streaming?: boolean;
  closePromise?: Promise<void>;
  secrets: Set<string>;
  recording?: {recorder:PageRecording; done:Promise<unknown>};
}
interface WorkspaceBinding { id: string; paused: boolean; profileId?:string; resume?: {conversation: string; message: string; turn: string; ticketId?:string} }
interface Receipt {
  fingerprint: string;
  state: "running" | "complete" | "uncertain";
  result?: unknown;
}
interface BrowserCapture {
  id:string;kind:'browser-screenshot'|'browser-recording';conversationId?:string;runId?:string;
  ticketId:string;assignmentId:string;path:string;name:string;bytes:number;mime:'image/png'|'video/mp4';
  resource:string;sha256:string;url?:string;title?:string;workspacePath?:string;
  explicitChat?:true;
}
const isCapture = (item: BrowserCapture | undefined): item is BrowserCapture =>
  item?.kind === 'browser-screenshot' || item?.kind === 'browser-recording';
const pngSignature = Buffer.from([137,80,78,71,13,10,26,10]);
const visibleActions = new Set<string>(['navigate','click','fill','press','scroll','back','forward','reload'] satisfies BrowserActivity['action'][]);

function finalizedMp4(bytes: Buffer) {
  let fileType = false, media = false, index = false;
  for (let offset = 0; offset + 8 <= bytes.length;) {
    let size = bytes.readUInt32BE(offset), header = 8;
    if (size === 1) {
      header = 16;
      if(offset + header > bytes.length)return false;
      size = Number(bytes.readBigUInt64BE(offset + 8));
    } else if (size === 0) size = bytes.length - offset;
    const type = bytes.toString('ascii', offset + 4, offset + 8);
    if (size < header || offset + size > bytes.length) return false;
    fileType ||= type === 'ftyp' && offset === 0;
    media ||= type === 'mdat' && size > header;
    index ||= type === 'moov' && size > header;
    offset += size;
  }
  return fileType && media && index;
}
const hash = (v: unknown) =>
  createHash("sha256").update(JSON.stringify(v)).digest("hex");
const cleanUrl = (value: string) => {
  try {
    const u = new URL(value);
    return ["http:", "https:"].includes(u.protocol) &&
      !u.username &&
      !u.password
      ? u.href
      : "about:blank";
  } catch {
    return "about:blank";
  }
};

/** Login snapshots contain only the requested site's cookies and origin storage. */
export function stateForOrigin(state: any, url: string) {
  const target = new URL(url),
    hostname = target.hostname;
  return {
    cookies: (Array.isArray(state.cookies) ? state.cookies : []).filter(
      (c: any) => {
        const domain = String(c.domain ?? "").replace(/^\./, "");
        return (
          domain && (hostname === domain || hostname.endsWith("." + domain))
        );
      },
    ),
    origins: (Array.isArray(state.origins) ? state.origins : []).filter(
      (o: any) => o.origin === target.origin,
    ),
  };
}

export class BrowserManager {
  private sessions = new Map<string, Session>();
  private opening = new Map<string, Promise<Session>>();
  private calls = new Map<
    string,
    { fingerprint: string; promise: Promise<unknown> }
  >();
  private root: string;
  private vault?: BrowserVault;
  private closing = false;
  private recovery: Promise<unknown>;
  private timer: ReturnType<typeof setInterval>;
  readonly driver: BrowserDriver;
  private readonly legacyDriver: BrowserDriver;
  constructor(
    private host: Runtime,
    driver?: BrowserDriver,
  ) {
    this.root = join(host.config.stateDir, "browser");
    this.legacyDriver = driver ?? new AgentBrowserDriver(this.root, host.config.browser);
    this.driver = driver ?? new ManagedBrowserDriver(host.config.browser);
    const abandoned = host.store
      .list<any>("browser-session")
      .filter((row) => row.active);
    this.recovery = Promise.allSettled(
      abandoned.map(async (row) => {
        // A preview build could leave a vendor Task Space behind. Only clean
        // Roppo state for that record; the product no longer requires its app.
        if(row.provider!=='ego-lite')await this.driverFor(row).close(row).catch(()=>{});
        if (!row.personal && !row.cdpPort)
          rmSync(row.directory, { recursive: true, force: true });
        host.store.put("browser-session", row.id, {
          ...row,
          active: false,
          interrupted: true,
        });
      }),
    );
    for (const row of host.store.list<any>("browser-receipt"))
      if (row.state === "running")
        host.store.put("browser-receipt", row.id, {
          ...row,
          state: "uncertain",
          result: undefined,
        });
    this.timer = setInterval(() => {
      for (const s of this.sessions.values()) {
        if (s.owner && !s.ended && !host.validWork(s.owner)) {
          this.endAssignment(s.owner.ticketId, s.owner.assignmentId);
        }
        if (s.control === "human" && s.leaseUntil < Date.now()) {
          s.control = "paused";
          s.client = undefined;
          s.epoch++;
        }
        if (
          Date.now() - s.updatedAt > host.config.browser.idleMs &&
          !s.workspace && s.control !== "human"
        )
          void this.closeSession(s).catch(() => {});
      }
    }, 10000);
    this.timer.unref();
  }
  private driverFor(session: DriverSession) {
    return session.provider === 'roppo' ? this.driver : this.legacyDriver;
  }
  private getVault() {
    return (this.vault ??= new BrowserVault(
      join(this.root, "vault"),
      this.host.config.browser.keyEnv,
    ));
  }
  private enabled() {
    if (this.closing || !this.host.config.browser.enabled)
      throw new BrowserError("browser_disabled", "Browser access is disabled.");
  }
  private principal(owner: WorkOwner) {
    if (!this.host.validWork(owner))
      throw new BrowserError(
        "browser_assignment_ended",
        "This assignment no longer owns a browser.",
      );
    const run = this.host.store.get<any>("run", owner.ticketId),
      options = run?.agentOptions?.browser;
    if (options?.enabled === false)
      throw new BrowserError(
        "browser_disabled",
        "Browser access is disabled for this Worker.",
      );
    const assignment = this.host.store.get<any>(
        "worker-assignment",
        owner.ticketId,
      ),
      chatRun =
        assignment?.parentTrigger &&
        this.host.store.get<any>("chat-run", assignment.parentTrigger),
      conversation =
        chatRun &&
        this.host.store.get<any>("chat-conversation", chatRun.conversationId);
    return {
      user: conversation?.owner ?? "host",
      workerId: run?.workerId ?? assignment?.workerId ?? "",
      conversationId: conversation?.id,
      maxTabs: options?.maxTabs ?? browserCapacity.defaultTabs,
    };
  }
  private profile(id: string, user: string) {
    const p = this.host.store.get<BrowserProfile>("browser-profile", id);
    if (!p || p.owner !== user)
      throw new BrowserError(
        "browser_profile_missing",
        "Browser profile not found.",
        404,
      );
    return p;
  }
  private authorizeProfile(id: string, user: string, worker?: string) {
    const p = this.profile(id, user);
    if (worker !== undefined && !this.canUseProfile(p, worker))
      throw new BrowserError(
        "browser_profile_denied",
        "This Worker cannot use this browser profile.",
        403,
      );
    return p;
  }
  private canUseProfile(profile: BrowserProfile, worker: string) {
    return !!worker && (profile.shareWithWorkers ?? profile.allowedWorkers.includes(worker));
  }
  private visible(s: Session, user: string) {
    if (s.user !== user && s.user !== "host")
      throw new BrowserError(
        "browser_missing",
        "Browser session not found.",
        404,
      );
    return s;
  }
  private session(id: string, user: string) {
    const s = this.sessions.get(id);
    if (!s || s.closing || !s.ready)
      throw new BrowserError(
        "browser_missing",
        "Browser session is closed.",
        404,
      );
    return this.visible(s, user);
  }
  private workerSession(id: string, owner: WorkOwner) {
    const principal = this.principal(owner),
      s = this.session(id, principal.user);
    if (
      !s.owner ||
      s.owner.ticketId !== owner.ticketId ||
      s.owner.assignmentId !== owner.assignmentId ||
      s.owner.agentId !== owner.agentId
    )
      throw new BrowserError(
        "browser_owner",
        "Browser belongs to a different assignment.",
        403,
      );
    if (s.profileId)
      this.authorizeProfile(s.profileId, principal.user, principal.workerId);
    return s;
  }
  private enqueue<T>(s: Session, action: () => Promise<T>): Promise<T> {
    const next = s.queue.catch(() => {}).then(action);
    s.queue = next.catch(() => {});
    return next;
  }
  private view(s: Session, client?: string) {
    return {
      id: s.id,
      profileId: s.profileId,
      personal: s.personal,
      ...(s.provider ? { provider: s.provider } : {}),
      workspace: s.workspace,
      workerId: s.workerId,
      conversationId: s.conversationId,
      control: s.control,
      epoch: s.epoch,
      revision: s.revision,
      controlledByYou: s.control === "human" && s.client === client,
      ended: s.ended,
      handoffReason: s.handoffReason,
      ticketId: s.owner?.ticketId,
      tabs: s.tabs,
      url: s.url,
      title: s.title,
      updatedAt: s.updatedAt,
      frameAt: s.frame?.at,
      streaming: !!s.streaming,
    };
  }
  /** Read-only operator summary: no vault access, URLs, page titles, profiles or credentials. */
  controlSummary(user:string){
    const sessions=[...this.sessions.values()].filter(s=>s.ready&&!s.closing&&!s.ended&&(s.user===user||s.user==='host'))
    return {total:sessions.length,items:sessions.slice(0,50).map(s=>({id:s.id,workerId:s.workerId,control:s.control}))}
  }
  list(user: string, client?: string, conversationId?: string) {
    const profiles = this.host.store
      .list<BrowserProfile>("browser-profile")
      .filter((p) => p.owner === user);
    return {
      enabled: this.host.config.browser.enabled,
      profiles,
      workspace: this.workspaceEnabled(user),
      credentials: this.getVault().list(user),
      sessions: [...this.sessions.values()]
        .filter(
          (s) =>
            s.ready && !s.closing && (s.user === user || s.user === "host") && (!conversationId || s.workspace || s.conversationId === conversationId),
        )
        .map((s) => this.view(s, client)),
      workers: workerProfiles(this.host.config).map((w) => ({
        id: w.id,
        label: w.label ?? w.id,
        enabled: w.browser?.enabled !== false,
      })),
    };
  }
  conversation(user: string, conversationId: string) {
    return [...this.sessions.values()]
      .filter(s => s.ready && !s.closing && s.user === user && s.conversationId === conversationId && (s.workspace || !s.personal))
      .map(s => ({...this.view(s), runId: s.owner ? this.host.taskAuthority(s.owner.ticketId)?.parentTrigger : s.routerTurn}));
  }
  waiting(ticketId: string, assignmentId: string) {
    return [...this.sessions.values()].find(s => !s.ended && !s.closing && s.owner?.ticketId === ticketId && s.owner.assignmentId === assignmentId && s.control !== 'worker');
  }
  private captureAttachment(a:BrowserCapture):ChatAttachment&{runId?:string;ticketId:string} {
    const url='/api/browser/screenshots/'+a.id;
    return {id:a.id,name:a.name,mimeType:a.mime??(a.kind==='browser-screenshot'?'image/png':'video/mp4'),bytes:a.bytes,runId:a.runId,ticketId:a.ticketId,url,previewUrl:url+'?preview=1'};
  }
  screenshots(conversationId:string,automaticOnly=false): (ChatAttachment & {runId?:string;ticketId:string})[] {
    return this.host.store.list<BrowserCapture>('asset')
      .filter(a=>isCapture(a)&&(!automaticOnly||!a.explicitChat)&&a.conversationId===conversationId&&!this.host.memory.cleanup.blocked('asset',a.id,a))
      .map(a=>this.captureAttachment(a));
  }
  shareScreenshot(id:string,conversationId:string,runIds:readonly string[],ticketId?:string):ChatAttachment|undefined {
    const asset=this.host.store.get<BrowserCapture>('asset',id);
    if(asset?.kind!=='browser-screenshot'||asset.conversationId!==conversationId||
       !asset.runId||!runIds.includes(asset.runId)||ticketId&&asset.ticketId!==ticketId||
       this.host.memory.cleanup.blocked('asset',id,asset))return;
    const file=lstatSync(asset.path,{throwIfNoEntry:false});
    if(!file?.isFile()||file.size!==asset.bytes)return;
    if(!asset.explicitChat)this.host.store.put('asset',id,{...asset,explicitChat:true});
    const {name,mimeType,bytes,url,previewUrl}=this.captureAttachment(asset);
    return {id,name,mimeType,bytes,url,previewUrl};
  }
  screenshot(user:string,id:string) {
    const asset=this.host.store.get<BrowserCapture>('asset',id);
    if(!isCapture(asset)||!asset.conversationId||this.host.memory.cleanup.blocked('asset',id,asset))throw new BrowserError('browser_missing','Capture is unavailable.');
    this.host.chat.view(asset.conversationId,user);
    return {...asset,mime:asset.mime??(asset.kind==='browser-screenshot'?'image/png':'video/mp4')};
  }
  saveCapture(owner: WorkOwner, mime: BrowserCapture['mime'], bytes: Buffer, page?: {url:string;title:string}) {
    const image = mime === 'image/png';
    if (bytes.length > captureLimit || !(image ? bytes.subarray(0,8).equals(pngSignature) : finalizedMp4(bytes)))
      throw new BrowserError('capture_invalid', 'The capture is invalid, unfinished, or exceeds the file limit.');
    const id = randomUUID(), name = image ? 'screenshot.png' : 'recording.mp4';
    const directory = join(this.host.config.stateDir, 'assets', id), path = join(directory, name);
    const assignment = this.host.store.get<{parentTrigger?:string}>('worker-assignment',owner.ticketId);
    const runId = this.host.taskAuthority(owner.ticketId)?.parentTrigger ?? assignment?.parentTrigger;
    const chat = runId ? this.host.store.get<{conversationId:string}>('chat-run',runId) : undefined;
    mkdirSync(directory,{recursive:true,mode:0o700});
    let workspacePath: string | undefined;
    try {
      writeFileSync(path,bytes,{flag:'wx',mode:0o400});
      if(owner.sandbox==='workspace-write'&&this.host.validWork(owner)) {
        const target=join(realpathSync(owner.cwd),'roppo-'+id+'-'+name);
        writeFileSync(target,bytes,{flag:'wx',mode:0o600});
        workspacePath=target;
      }
      const asset:BrowserCapture={id,kind:image?'browser-screenshot':'browser-recording',conversationId:chat?.conversationId,
        runId,path,name,bytes:bytes.length,ticketId:owner.ticketId,assignmentId:owner.assignmentId,
        resource:'asset/'+id,mime,sha256:createHash('sha256').update(bytes).digest('hex'),workspacePath,...(image?{explicitChat:true}:{}),...page};
      this.host.store.put('asset',id,asset);
      return asset;
    } catch(error) {
      rmSync(directory,{recursive:true,force:true});
      if(workspacePath)rmSync(workspacePath,{force:true});
      throw error;
    }
  }
  saveProfile(
    user: string,
    input: BrowserProfileInput,
    id: string = randomUUID(),
  ) {
    this.enabled();
    const old = this.host.store.get<BrowserProfile>("browser-profile", id);
    if (old) this.profile(id, user);
    // An absent sharing setting preserves the access policy of an older profile.
    const shareWithWorkers = input.shareWithWorkers ?? old?.shareWithWorkers;
    const grants = shareWithWorkers === undefined ? input.allowedWorkers ?? old?.allowedWorkers ?? [] : [];
    const ids = new Set(workerProfiles(this.host.config).map((w) => w.id));
    if (grants.some((id) => !ids.has(id) && !old?.allowedWorkers.includes(id)))
      throw new BrowserError(
        "browser_worker_missing",
        "Worker is no longer available.",
      );
    const p: BrowserProfile = {
      id,
      owner: user,
      name: input.name,
      shareWithWorkers,
      allowedWorkers: grants.filter((id) => ids.has(id)),
      tabs: old?.tabs ?? ["about:blank"],
      activeTab: old?.activeTab ?? 0,
      updatedAt: Date.now(),
    };
    this.host.store.put("browser-profile", id, p);
    return p;
  }
  saveCredential(
    user: string,
    input: {
      profileId: string;
      label: string;
      url: string;
      username: string;
      password: string;
    },
    id?: string,
  ) {
    this.profile(input.profileId, user);
    return this.getVault().save(
      user,
      { ...input, url: new URL(input.url).href },
      id,
    );
  }
  removeCredential(user: string, id: string) {
    this.getVault().remove(user, id);
  }
  private async capture(s: Session, signal?: AbortSignal) {
    const driver = this.driverFor(s);
    const data = await driver.run(s, ["tab", "list"], signal);
    const tabs: Session["tabs"] = (data.tabs ?? []).map((t: any, i: number) => {
      const url = cleanUrl(t.url ?? "about:blank");
      let title = String(t.title ?? "").slice(0, 200);
      // The CDP driver can report a URL placeholder even for a previously inspected document.
      if (s.cdpPort && (!title || title === url || title === url.replace(/^https?:\/\//, ""))) {
        const previous = s.tabs.find(tab => tab.id === t.tabId && tab.url === url);
        if (previous?.title) title = previous.title;
      }
      return {id: t.tabId, index: t.index ?? i, url, title, active: t.active === true};
    });
    const active = tabs.find(tab => tab.active) ?? tabs[0];
    if (s.cdpPort && active) {
      const page = await driver.run(s, ["get", "title"], signal);
      if (typeof page.title === "string") active.title = page.title.slice(0, 200);
    }
    s.tabs = tabs;
    if (s.url !== (active?.url ?? "about:blank")) s.revision++;
    s.url = active?.url ?? "about:blank";
    s.title = active?.title ?? "";
    if (s.personal && s.profileId) {
      const p = this.profile(s.profileId, s.user);
      this.host.store.put("browser-profile", p.id, {
        ...p,
        tabs: s.tabs.map((t) => t.url),
        activeTab: s.tabs.findIndex((t) => t.active),
        updatedAt: s.updatedAt,
      });
    }
  }
  private async create(
    user: string,
    personal: boolean,
    profileId?: string,
    owner?: WorkOwner,
    url = "about:blank",
    workspace?: WorkspaceBinding,
  ) {
    this.enabled();
    browserUrl.parse(url);
    await this.recovery;
    this.enabled();
    if (this.sessions.size >= this.host.config.browser.maxSessions) {
      const retained = [...this.sessions.values()]
        .filter(s => s.ended && !s.watchers.size && s.control === 'ended' && !s.closing)
        .sort((a, b) => a.updatedAt - b.updatedAt)[0];
      if (retained) await this.closeSession(retained);
    }
    if (this.sessions.size >= this.host.config.browser.maxSessions)
      throw new BrowserError(
        "browser_capacity",
        "Close an idle browser before opening another.",
      );
    const principal = owner ? this.principal(owner) : undefined;
    const p = profileId
      ? this.authorizeProfile(profileId, user, principal?.workerId)
      : undefined;
    const external = workspace&&this.host.config.browser.workspace?.owner===user ? this.host.config.browser.workspace.cdpPort : undefined;
    const managed = !this.host.config.browser.command;
    const id = workspace?.id ?? randomUUID(),
      directory = join(
        this.root,
        external ? "workspace" : personal ? "profiles" : "tasks",
        personal && p ? p.id : id,
      );
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    // Upload selections belong to one browser lifetime, including a recovered profile.
    rmSync(join(directory,'uploads'),{recursive:true,force:true});
    mkdirSync(join(directory,'downloads'),{recursive:true,mode:0o700});
    const s: Session = {
      id,
      directory,
      provider: managed ? this.driver.provider : undefined,
      user,
      personal,
      workspace: !!workspace,
      persistent:personal&&!external,
      profileId,
      owner,
      workerId: principal?.workerId,
      conversationId: principal?.conversationId,
      cdpPort: external,
      control: workspace ? workspace.paused ? "paused" : "router" : personal ? "paused" : "worker",
      epoch: workspace ? Date.now() : 0,
      revision: 0,
      leaseUntil: 0,
      ended: false,
      maxTabs: principal?.maxTabs ?? browserCapacity.defaultTabs,
      closing: false,
      tabs: [],
      url: "about:blank",
      title: "",
      updatedAt: Date.now(),
      watchers: new Set(),
      ready: false,
      queue: Promise.resolve(),
      controller: new AbortController(),
      secrets: new Set(),
    };
    this.sessions.set(id, s);
    this.host.store.put("browser-session", id, {
      id,
      directory,
      cdpPort: s.cdpPort,
      provider: s.provider,
      personal,
      persistent:s.persistent,
      profileId,
      user,
      active: true,
    });
    s.initialization = (async () => {
      const driver = this.driverFor(s);
      if (s.cdpPort) {
        await this.capture(s, s.controller.signal);
        s.conversationId = workspace?.resume?.conversation;
        s.ready = true;
        return;
      }
      // Reap only our previous daemon for this exact personal profile before reopening it.
      if (personal && p)
        for (const old of this.host.store
          .list<any>("browser-session")
          .filter(
            (row) =>
              row.id !== id &&
              row.personal &&
              row.profileId === p.id &&
              row.user === user &&
              row.active,
          )) {
          await this.driverFor(old).close({ ...old, directory });
          this.host.store.put("browser-session", old.id, {
            ...old,
            active: false,
          });
        }
      if (s.provider !== 'roppo' || p && !personal && url !== 'about:blank')
        await driver.run(s, ["open", "about:blank"], s.controller.signal);
      if (!personal && p && url !== "about:blank") {
        const source = await this.openPersonalSession(user, p.id);
        const state = await this.enqueue(source, () => {
          this.authorizeProfile(p.id, user, principal!.workerId);
          return this.driverFor(source).state(source, source.controller.signal);
        });
        await driver.load(
          s,
          stateForOrigin(state, url),
          s.controller.signal,
        );
      }
      const urls = personal && p ? p.tabs.slice(0, 8) : [url];
      for (let i = 0; i < urls.length; i++)
        await driver.run(
          s,
          i ? ["tab", "new", cleanUrl(urls[i]!)] : ["open", cleanUrl(urls[i]!)],
          s.controller.signal,
        );
      if (personal && p && p.activeTab !== undefined && p.activeTab >= 0) {
        const restored=await driver.run(s,["tab","list"],s.controller.signal);
        const tabId=restored.tabs?.[p.activeTab]?.tabId;
        if(tabId)await driver.run(s,["tab",tabId],s.controller.signal);
      }
      if (owner) {
        this.principal(owner);
        if (profileId)
          this.authorizeProfile(profileId, user, principal!.workerId);
      }
      await this.capture(s, s.controller.signal);
      if(workspace?.resume)s.conversationId=workspace.resume.conversation;
      if (s.closing)
        throw new BrowserError(
          "browser_cancelled",
          "Browser was closed while opening.",
        );
      s.ready = true;
    })();
    try {
      await s.initialization;
      return s;
    } catch (error) {
      await this.closeSession(s).catch(() => {});
      throw error;
    }
  }
  private openPersonalSession(
    user: string,
    profileId: string,
  ): Promise<Session> {
    this.profile(profileId, user);
    if (this.managedWorkspace(user) && this.defaultProfile(user)?.id === profileId)
      return this.workspaceSession(user);
    const live = [...this.sessions.values()].find(
      (s) =>
        s.personal &&
        s.user === user &&
        s.profileId === profileId &&
        !s.closing,
    );
    const key = user + ":" + profileId,
      pending = this.opening.get(key);
    if (pending) return pending;
    if (live) return Promise.resolve(live);
    const promise = this.create(user, true, profileId).finally(() =>
      this.opening.delete(key),
    );
    this.opening.set(key, promise);
    return promise;
  }
  private receiveFrame(s: Session, frame: BrowserFrame) {
    if (s.closing) return;
    s.frame = { ...frame, seq: (s.frame?.seq ?? 0) + 1 };
    for (const notify of s.watchers) notify();
  }
  async openPersonal(user: string, profileId: string, client: string, conversationId?: string) {
    const s = await this.openPersonalSession(user, profileId);
    if(conversationId&&!s.workspace){
      if(s.conversationId && s.conversationId!==conversationId)throw new BrowserError('browser_profile_in_use','This browser is open in another conversation. Create another browser or close it there first.')
      s.conversationId=conversationId
    }
    if (s.control === "paused" || s.control === "router") await this.takeover(user, s.id, client);
    return this.view(s, client);
  }
  workspaceEnabled(user: string) {
    return this.host.config.browser.enabled &&
      (this.host.config.browser.workspace?.owner === user || this.managedWorkspace(user));
  }
  private managedWorkspace(user: string) {
    const config = this.host.config.browser;
    return this.driver.provider === 'roppo' && !config.command && config.workspace?.owner !== user;
  }
  private defaultProfile(user: string) {
    const saved = this.host.store.get<WorkspaceBinding>("browser-workspace",user);
    const pinned = saved?.profileId && this.host.store.get<BrowserProfile>('browser-profile',saved.profileId);
    return pinned && pinned.owner === user ? pinned :
      this.host.store.list<BrowserProfile>('browser-profile').find(p=>p.owner===user);
  }
  private workspaceBinding(user: string): WorkspaceBinding {
    const saved = this.host.store.get<WorkspaceBinding>("browser-workspace", user);
    const binding: WorkspaceBinding = saved ?? {id: randomUUID(), paused: false};
    if (this.managedWorkspace(user)) {
      const profile = this.defaultProfile(user) ?? this.saveProfile(user,{name:'Browser'});
      if (saved?.profileId === profile.id) return saved;
      binding.profileId = profile.id;
    } else if (saved) return saved;
    this.host.store.put("browser-workspace", user, binding);
    return binding;
  }
  private workspaceSession(user: string): Promise<Session> {
    this.enabled();
    if (!this.workspaceEnabled(user)) throw new BrowserError("browser_owner", "Workspace browser unavailable.", 403);
    const binding = this.workspaceBinding(user);
    const pending = this.opening.get(binding.id);
    if (pending) return pending;
    const live = this.sessions.get(binding.id);
    if (live?.ready && !live.closing) return Promise.resolve(live);
    const opening = this.create(user, true, this.managedWorkspace(user) ? binding.profileId : undefined, undefined, "about:blank", binding)
      .catch(error => {
        if (error instanceof BrowserError && ["browser_command_failed","browser_uncertain","browser_unavailable"].includes(error.code))
          throw new BrowserError("browser_workspace_offline", "The workspace Chromium is reconnecting.", 503);
        throw error;
      })
      .finally(() => this.opening.delete(binding.id));
    this.opening.set(binding.id, opening);
    return opening;
  }
  async restoreWorkspace(user: string, sessionId?: string) {
    if (!this.workspaceEnabled(user)) return;
    const binding = this.host.store.get<WorkspaceBinding>("browser-workspace",user);
    if (binding && (!sessionId || binding.id === sessionId)) await this.workspaceSession(user);
  }
  private pauseWorkspace(s: Session) {
    if (!s.workspace) return;
    const binding = this.workspaceBinding(s.user);
    binding.paused = true;
    if (s.routerConversation && s.routerTurn && !binding.resume)
      binding.resume = {conversation: s.routerConversation, message: randomUUID(), turn:s.routerTurn, ticketId:s.workspaceTicket};
    this.host.store.put("browser-workspace", s.user, binding);
  }
  endRouterTurn(turn: string, ticketId?:string) {
    for (const s of this.sessions.values()) if (s.routerTurn === turn && s.workspaceTicket === ticketId) {
      s.routerTurn = undefined;
      s.routerConversation = undefined;
      s.workspaceTicket = undefined;
    }
  }
  async routerAction(user: string, conversation: string, turn: string, input: unknown, valid: () => void, deadline?:AbortSignal, ticketId?:string) {
    const action = workspaceAction(input);
    deadline?.throwIfAborted();
    valid();
    const s = await abortable(this.workspaceSession(user),deadline);
    const signal = deadline ? AbortSignal.any([s.controller.signal,deadline]) : s.controller.signal;
    const epoch = s.epoch;
    const guard = () => {
      signal.throwIfAborted();
      valid();
      if (s.closing || s.control !== "router" || s.epoch !== epoch)
        throw new BrowserError("browser_control_required", "The user has control. Wait for them to return the workspace browser.");
      if (s.routerTurn && (s.routerTurn !== turn || s.workspaceTicket !== ticketId))
        throw new BrowserError("browser_control_busy", "Another task is using this browser.");
    };
    return abortable(this.enqueue(s, async () => {
      guard();
      s.routerTurn = turn;
      s.routerConversation = conversation;
      s.workspaceTicket = ticketId;
      s.conversationId = conversation;
      if (action.action === "request_takeover") this.pauseWorkspace(s);
      await this.perform(s, action, guard, false, signal);
      if (action.action === "request_takeover") return this.view(s);
      guard();
      const page = await this.snapshot(s,signal);
      guard();
      return page;
    }),deadline);
  }
  async openDefault(user:string,client:string,conversationId:string) {
    if (this.workspaceEnabled(user)) {
      const s = await this.workspaceSession(user);
      return s.control === "paused" || s.control === "router"
        ? this.takeover(user, s.id, client) : this.view(s, client);
    }
    const existing=this.host.store.list<BrowserProfile>('browser-profile').find(p=>p.owner===user);
    const profile=existing??this.saveProfile(user,{name:'Browser',allowedWorkers:[]});
    return this.openPersonal(user,profile.id,client,conversationId);
  }
  async takeover(user: string, id: string, client: string, force = false) {
    const s = this.session(id, user);
    if (s.control === "human" && s.client === client) {
      s.leaseUntil = Date.now() + 90000;
      return this.view(s, client);
    }
    if (
      s.control === "handoff" ||
      (s.control === "human" && s.leaseUntil > Date.now() && !force)
    )
      throw new BrowserError(
        "browser_control_busy",
        "This browser is controlled in another window.",
      );
    this.pauseWorkspace(s);
    s.control = "handoff";
    s.epoch++;
    const epoch = s.epoch;
    await this.enqueue(s, async () => {
      if (s.closing || s.epoch !== epoch)
        throw new BrowserError(
          "browser_control_changed",
          "Browser control changed.",
        );
      if(s.recording)await this.stopRecording(s).catch(()=>{});
      if(s.closing||s.epoch!==epoch)throw new BrowserError("browser_control_changed","Browser control changed.");
      s.control = "human";
      s.client = client;
      s.leaseUntil = Date.now() + 90000;
      s.revision++;
      s.updatedAt = Date.now();
    });
    return this.view(s, client);
  }
  private human(s: Session, client: string, epoch: number) {
    if (
      s.control !== "human" ||
      s.client !== client ||
      s.epoch !== epoch ||
      s.leaseUntil < Date.now()
    )
      throw new BrowserError(
        "browser_control_required",
        "Take control of this browser before interacting.",
      );
    s.leaseUntil = Date.now() + 90000;
    s.updatedAt = Date.now();
  }
  renew(user: string, id: string, client: string, epoch: number) {
    const s = this.session(id, user);
    this.human(s, client, epoch);
    return this.view(s, client);
  }
  async release(user: string, id: string, client: string, epoch: number) {
    const s = this.session(id, user);
    this.human(s, client, epoch);
    s.control = "handoff";
    s.epoch++;
    await this.enqueue(s, async () => {
      try {
        if (s.workspace) this.host.store.atomic(() => {
          const binding = this.workspaceBinding(user);
          const pending = binding.resume;
          if (pending?.ticketId) {
            const origin = this.host.chat.taskWorkspaceBrowser(pending.ticketId);
            if (origin?.owner === user && origin.triggerId === pending.turn && origin.conversationId === pending.conversation)
              this.noteBrowserReturn(pending.ticketId,s.id);
          } else if (pending && !this.host.store.get<{cancelRequested?:boolean}>("chat-run",pending.turn)?.cancelRequested) {
            const locale = this.host.chat.locale(pending.turn);
            this.host.chat.send(pending.conversation, user, {
              clientMessageId: pending.message, locale,
              text: locale?.startsWith("en") ? "I returned the workspace browser. Inspect the current tab and continue our browser task."
                : "已交还工作区浏览器。请重新读取当前标签页，继续刚才的浏览器任务。",
            });
          }
          this.host.store.put("browser-workspace", user, {id:s.id, profileId:binding.profileId, paused:false});
        });
      } catch (error) {
        s.control = "human";
        s.epoch = epoch;
        throw error;
      }
      s.client = undefined;
      s.revision++;
      s.control = s.workspace ? "router" : s.personal ? "paused" : s.ended ? "ended" : "worker";
      s.handoffReason = undefined;
      s.updatedAt = Date.now();
    });
    if (s.owner && !s.ended && this.host.validWork(s.owner)) this.host.store.atomic(() => this.noteBrowserReturn(s.owner!.ticketId,s.id));
    return this.view(s, client);
  }
  private noteBrowserReturn(ticketId:string,browserId:string) {
    const task = this.host.store.tickets.get(ticketId);
    if (!task || task.ended) return;
    this.host.engine.note(ticketId,
      `The user returned browser ${browserId}. Continue the same task autonomously. Read a fresh browser snapshot first; previous element references have expired.`);
    allowNewTaskInputs(this.host.store,ticketId,task.inputs.map(i=>i.id));
  }
  async subscribe(user: string, id: string, onFrame?: () => void) {
    await this.restoreWorkspace(user, id);
    const s = this.session(id, user);
    const notify = () => onFrame?.();
    s.watchers.add(notify);
    try {
      await this.enqueue(s, () => this.ensureFrames(s));
    } catch (error) {
      s.watchers.delete(notify);
      throw error;
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      s.watchers.delete(notify);
      if (!s.watchers.size) {
        s.stopFrames?.();
        s.stopFrames = undefined;
        s.streaming = false;
      }
    };
  }
  private async ensureFrames(s: Session) {
    if (s.closing || !s.watchers.size || s.streaming) return;
    s.startingFrames ??= (async () => {
      s.stopFrames?.();
      s.stopFrames = await this.driverFor(s).frames(
        s,
        (frame) => this.receiveFrame(s, frame),
        (connected) => { s.streaming = connected; },
      );
      if (s.closing || !s.watchers.size) {
        s.stopFrames();
        s.stopFrames = undefined;
        s.streaming = false;
      }
    })().finally(() => { s.startingFrames = undefined; });
    await s.startingFrames;
  }
  frame(user: string, id: string) {
    return this.session(id, user).frame;
  }
  activity(user:string,id:string) {
    const s=this.session(id,user), activity=s.activity
    if(!activity||s.activityEpoch!==s.epoch||Date.now()-activity.at>1800)return
    if(s.control==='worker'||s.control==='router')return activity
  }
  streamStatus(user: string, id: string) {
    return !!this.session(id, user).streaming;
  }
  async inspect(user: string, id: string, client?: string) {
    await this.restoreWorkspace(user, id);
    const s = this.session(id, user);
    return this.enqueue(s, async () => {
      await this.capture(s, s.controller.signal);
      await this.ensureFrames(s);
      return this.view(s, client);
    });
  }
  async action(
    user: string,
    id: string,
    client: string,
    epoch: number,
    input: BrowserAction,
  ) {
    const s = this.session(id, user);
    this.human(s, client, epoch);
    return this.enqueue(s, async () => {
      this.human(s, client, epoch);
      await this.perform(s, input, () => this.human(s, client, epoch));
      return this.view(s, client);
    });
  }
  async input(
    user: string,
    id: string,
    client: string,
    epoch: number,
    event: BrowserInput,
  ) {
    const s=this.session(id,user);
    this.human(s,client,epoch);
    return this.enqueue(s,async()=>{
      this.human(s,client,epoch);
      // The stream forwards key events, but Chromium on macOS needs an editing
      // command for select-all. Keep it in the same guarded input queue.
      if(event.type==='key'&&((event.key.toLowerCase()==='a'&&[2,4].includes(event.modifiers??0))||/^(Control|Meta)\+a$/i.test(event.key)))
        await this.driverFor(s).evaluate(s,`(()=>{let d=document;while(d.activeElement?.tagName==='IFRAME'&&d.activeElement.contentDocument)d=d.activeElement.contentDocument;const e=d.activeElement;if(e&&(e.tagName==='INPUT'||e.tagName==='TEXTAREA')&&typeof e.select==='function')e.select();else d.execCommand('selectAll')})()`,s.controller.signal);
      else await this.driverFor(s).input(s,event);
      s.revision++;
      return this.view(s,client);
    });
  }
  async resize(user:string,id:string,client:string,epoch:number,width:number,height:number) {
    const s=this.session(id,user);this.human(s,client,epoch);
    return this.enqueue(s,async()=>{
      this.human(s,client,epoch);
      await this.driverFor(s).run(s,['set','viewport',String(width),String(height)],s.controller.signal);
      s.revision++;
      return this.view(s,client);
    });
  }
  async selection(user:string,id:string,client:string,epoch:number) {
    const s=this.session(id,user);this.human(s,client,epoch);
    return this.enqueue(s,async()=>{
      this.human(s,client,epoch);
      const text=await this.driverFor(s).evaluate(s,`(()=>{let d=document;while(d.activeElement?.tagName==='IFRAME'&&d.activeElement.contentDocument)d=d.activeElement.contentDocument;const e=d.activeElement;const text=e&&(e.tagName==='INPUT'||e.tagName==='TEXTAREA')&&e.selectionStart!==null?e.value.slice(e.selectionStart,e.selectionEnd):d.getSelection()?.toString()||'';return text})()`,s.controller.signal);
      return {text};
    });
  }
  downloads(user:string,id:string){return browserDownloads(this.session(id,user).directory)}
  download(user:string,id:string,name:string){return browserDownload(this.session(id,user).directory,name)}
  async uploadTargets(user:string,id:string,client:string,epoch:number){
    const s=this.session(id,user);this.human(s,client,epoch);
    return this.enqueue(s,async()=>{
      this.human(s,client,epoch);
      return this.driverFor(s).evaluate(s,`Array.from(document.querySelectorAll('input[type="file"]')).filter(e=>!e.disabled).map((e,i)=>{e.dataset.roppoUpload = ${JSON.stringify(randomUUID())}+'-'+i;return {id:e.dataset.roppoUpload,label:e.labels?.[0]?.innerText||e.getAttribute('aria-label')||e.name||('File '+(i+1)),accept:e.accept}})`,s.controller.signal);
    });
  }
  async upload(user:string,id:string,client:string,epoch:number,target:string,name:string,body:AsyncIterable<Uint8Array>,authorized:()=>boolean){
    const s=this.session(id,user);this.human(s,client,epoch);
    return this.enqueue(s,async()=>{
      this.human(s,client,epoch);
      await browserUpload(s.directory,name,body,async path=>{
        if(!authorized())throw new BrowserError('browser_control_required','Sign in again before uploading.',401);
        this.human(s,client,epoch);
        await this.driverFor(s).run(s,['upload',`input[type="file"][data-roppo-upload="${target}"]`,path],s.controller.signal);
        this.human(s,client,epoch);
        s.revision++;
      });
      return this.view(s,client);
    });
  }

  private async perform(s: Session, input: BrowserAction, guard: () => void, download = false, signal = s.controller.signal) {
    guard();
    const tab=s.tabs.find(item=>item.active)?.id,epoch=s.epoch
    let downloaded: {name:string} | undefined;
    if (
      ["click", "fill", "press"].includes(input.action) &&
      input.revision !== s.revision
    )
      throw new BrowserError(
        "browser_stale_snapshot",
        "The page or control changed. Read a fresh snapshot.",
      );
    if (s.workspace && input.action === "close_tab" && s.tabs.length <= 1)
      throw new BrowserError("browser_tab_limit","The workspace browser keeps one tab open.");
    if (input.action === "new_tab" && s.tabs.length >= s.maxTabs)
      throw new BrowserError(
        "browser_tab_limit",
        "This browser has reached its tab limit.",
      );
    if (["select_tab","close_tab"].includes(input.action) && !s.tabs.some(tab=>tab.id===input.tab))
      throw new BrowserError("browser_tab_missing","This tab has closed. Refresh the page state.");
    if (input.action === "request_takeover") {
      if(s.recording)await this.stopRecording(s).catch(()=>{});
      guard();
      s.control = "paused";
      s.epoch++;
      s.handoffReason = input.reason;
      s.updatedAt = Date.now();
      return;
    }
    if (input.action === "login") {
      const credential = this.getVault().read(s.user, input.credentialId!);
      if (credential.profileId !== s.profileId)
        throw new BrowserError(
          "browser_account_denied",
          "Saved account belongs to a different browser profile.",
          403,
        );
      const origin = new URL(credential.url).origin;
      if (new URL(s.url).origin !== origin)
        await this.driverFor(s).run(s, ["open", credential.url], signal);
      guard();
      s.secrets.add(credential.password);
      // Sent over stdin, never process argv. No password or form values in the result.
      const outcome = await this.driverFor(s).evaluate(
        s,
        `(()=>{if(location.origin!==${JSON.stringify(origin)})return {filled:false};const visible=e=>!!e&&e.getClientRects().length&&!e.disabled;const passwords=[...document.querySelectorAll('input[type="password"]')].filter(visible);if(passwords.length!==1)return {filled:false};const p=passwords[0],form=p.form,root=form||document;const u=[...root.querySelectorAll('input[autocomplete="username"],input[type="email"],input[type="text"]')].find(visible);if(!u)return {filled:false};const set=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;set.call(u,${JSON.stringify(credential.username)});u.dispatchEvent(new Event('input',{bubbles:true}));u.dispatchEvent(new Event('change',{bubbles:true}));set.call(p,${JSON.stringify(credential.password)});p.dispatchEvent(new Event('input',{bubbles:true}));p.dispatchEvent(new Event('change',{bubbles:true}));p.focus();return {filled:true}})()`,
        signal,
      );
      if (!outcome?.filled)
        throw new BrowserError(
          "browser_login_form",
          "Could not identify the login form. Take control to finish signing in.",
        );
    } else {
      const actions: Record<string, string[]> = {
        navigate: ["open", input.url!],
        snapshot: ["snapshot", "-i"],
        click: ["click", input.ref!, ...(download?["--download"]:[])],
        fill: ["fill", input.ref!, input.text!],
        press: ["press", input.key!],
        scroll: ["scroll", input.direction!, String(input.amount ?? 500)],
        new_tab: ["tab", "new", input.url!],
        select_tab: ["tab", String(input.tab)],
        close_tab: ["tab", "close", String(input.tab)],
        back: ["back"],
        forward: ["forward"],
        reload: ["reload"],
      };
      if (s.cdpPort && s.provider !== 'roppo' && input.action === "click") {
        await this.driverFor(s).run(s, ["scrollintoview", input.ref!], signal);
        guard();
      }
      if (input.action !== "snapshot") {
        const result=await this.driverFor(s).run(s, actions[input.action]!, signal)
        downloaded=result?.download
        if(tab&&s.watchers.size&&epoch===s.epoch&&!signal.aborted&&
           (s.control==='router'||s.control==='worker')&&visibleActions.has(input.action)){
          const point=result?.point as BrowserActivity['point']
          const positioned=point&&[point.x,point.y].every(value=>Number.isFinite(value)&&value>=0&&value<=1)
          s.activity={action:input.action as BrowserActivity['action'],tab,at:Date.now(),seq:(s.activity?.seq??0)+1,
            ...(positioned?{point:{x:point.x,y:point.y}}:{})}
          s.activityEpoch=epoch
          for(const notify of s.watchers)notify()
        }
      }
    }
    if (input.action !== "snapshot") s.revision++;
    s.updatedAt = Date.now();
    await this.capture(s, signal);
    return downloaded;
  }
  private async snapshot(s: Session, signal = s.controller.signal) {
    const result = await this.driverFor(s).run(
      s,
      ["snapshot"],
      signal,
    );
    s.revision++;
    let text = String(result.snapshot ?? "");
    // Saved credentials may appear in reflected page content. Never project them into model history.
    for (const secret of s.secrets)
      if (secret) text = text.split(secret).join("[hidden]");
    let resultText = JSON.stringify({
      ...this.view(s),
      snapshot: text.slice(0, browserCapacity.snapshotCharacters),
      ...(text.length > browserCapacity.snapshotCharacters ? {snapshotTruncated: true, totalCharacters: text.length} : {}),
    });
    for (const secret of s.secrets)
      if (secret)
        resultText = resultText
          .split(JSON.stringify(secret).slice(1, -1))
          .join("[hidden]");
    return JSON.parse(resultText);
  }
  async tool(owner: WorkOwner, input: BrowserToolInput): Promise<unknown> {
    this.enabled();
    const p = this.principal(owner);
    const key = hash([
        owner.ticketId,
        owner.assignmentId,
        owner.agentId ?? "",
        input.requestId,
      ]),
      fingerprint = hash(input);
    const record = (state: Receipt["state"], result?: unknown) => {
      this.host.store.put("browser-receipt", key, {
        id: key,
        fingerprint,
        ticketId: owner.ticketId,
        assignmentId: owner.assignmentId,
        action: input.action,
        state,
        ...(result !== undefined ? { result } : {}),
      });
    };
    const current = this.calls.get(key);
    if (current) {
      if (current.fingerprint !== fingerprint)
        throw new BrowserError(
          "browser_request_reused",
          "requestId was reused with different input.",
        );
      return current.promise;
    }
    const saved = this.host.store.get<Receipt>("browser-receipt", key);
    if (saved) {
      if (saved.fingerprint !== fingerprint)
        throw new BrowserError(
          "browser_request_reused",
          "requestId was reused with different input.",
        );
      const profileId = (saved.result as any)?.profileId ?? input.profileId;
      if (profileId) this.authorizeProfile(profileId, p.user, p.workerId);
      if (saved.state !== "complete")
        throw new BrowserError(
          "browser_uncertain",
          "Previous browser action has an uncertain result. Inspect the page; do not repeat the write.",
        );
      return saved.result;
    }
    const promise = (async () => {
      if (input.action === "profiles")
        return {
          profiles: this.host.store
            .list<BrowserProfile>("browser-profile")
            .filter(
              (v) =>
                v.owner === p.user && this.canUseProfile(v, p.workerId),
            )
            .map((v) => ({
              id: v.id,
              name: v.name,
              accounts: this.getVault()
                .list(p.user)
                .filter((a) => a.profileId === v.id)
                .map(({ id, label, url }) => ({ id, label, url })),
            })),
        };
      if (input.action === "open") {
        record("running");
        try {
          const s = await this.create(
            p.user,
            false,
            input.profileId,
            owner,
            input.url ?? "about:blank",
          );
          const value = await this.snapshot(s);
          record("complete", value);
          return value;
        } catch (error) {
          record("uncertain");
          throw error;
        }
      }
      if (!input.sessionId)
        throw new BrowserError(
          "browser_session_required",
          "sessionId is required for this browser action.",
          400,
        );
      const s = this.workerSession(input.sessionId, owner),
        epoch = s.epoch;
      if (s.control !== "worker")
        throw new BrowserError(
          "browser_human_control",
          "Browser is waiting for the user. Continue only after control is returned.",
        );
      return this.enqueue(s, async () => {
        const guard = () => {
          this.workerSession(s.id, owner);
          if (s.control !== "worker" || s.epoch !== epoch)
            throw new BrowserError(
              "browser_control_changed",
              "Browser control changed. Read a fresh snapshot after the user returns control.",
            );
        };
        guard();
        if (input.action === 'record_start' || input.action === 'record_stop') {
          if (!this.driverFor(s).record)
            throw new BrowserError('browser_recording_unavailable', 'Tab recording requires the managed Roppo browser.');
          record('running');
          try {
            const result = input.action === 'record_start' ? await this.startRecording(s, owner, input.durationMs) :
              await this.stopRecording(s);
            record('complete', result);
            return result;
          } catch (error) {
            record('uncertain');
            throw error;
          }
        }
        if (input.action === "screenshot") {
          const id=randomUUID(),directory=join(this.host.config.stateDir,"assets",id),path=join(directory,"screenshot.png");
          mkdirSync(directory,{recursive:true,mode:0o700});
          record("running");
          try {
            await this.driverFor(s).run(s,["screenshot",path,...(input.fullPage?["--full"]:[])],s.controller.signal);
            guard();
            const bytes=evidenceBytes(directory,"screenshot.png",32*1024*1024);
            if(!bytes||!bytes.subarray(0,8).equals(pngSignature))throw new BrowserError("browser_screenshot","Browser did not return a PNG screenshot.");
            chmodSync(path,0o400);
            const screenshot:BrowserCapture={id,kind:'browser-screenshot',conversationId:s.conversationId,runId:this.host.taskAuthority(owner.ticketId)?.parentTrigger,path,name:"screenshot.png",bytes:bytes.length,ticketId:owner.ticketId,assignmentId:owner.assignmentId,resource:"asset/"+id,mime:"image/png",sha256:createHash("sha256").update(bytes).digest("hex"),explicitChat:true,url:s.url,title:s.title};
            const page=await this.snapshot(s);
            guard();
            // The native model's filesystem policy excludes host state. Deliver
            // writable tasks a fresh workspace file instead of asking the model
            // to reinterpret that policy for an attachment exception.
            const workspacePath=owner.sandbox==='workspace-write'?join(realpathSync(owner.cwd),'roppo-screenshot-'+id+'.png'):undefined;
            if(workspacePath)writeFileSync(workspacePath,bytes,{flag:'wx',mode:0o600});
            const result={...page,screenshot:{...screenshot,...(workspacePath?{workspacePath}:{})}};
            this.host.store.atomic(()=>{this.host.store.put("asset",id,screenshot);record("complete",result)});
            return result;
          } catch(error) {
            rmSync(directory,{recursive:true,force:true});
            record("uncertain");
            throw error;
          }
        }
        if (input.action === "close") {
          record("running");
          await this.closeSession(s, false);
          const result = { closed: true };
          record("complete", result);
          return result;
        }
        const { sessionId, profileId, requestId, fullPage, durationMs, inlineImage, download, ...args } = input,
          action = browserAction.parse(args);
        if(download&&(action.action!=='click'||s.provider!=='roppo'))
          throw new BrowserError('browser_download_action','Use download:true with a managed browser click.',400);
        // Validation and ownership failures are retryable with the same requestId; only execution is receipted.
        if (
          ["click", "fill", "press"].includes(action.action) &&
          action.revision !== s.revision
        )
          throw new BrowserError(
            "browser_stale_snapshot",
            "Read a fresh snapshot before acting.",
          );
        record("running");
        try {
          const downloaded = await this.perform(s, action, guard, download);
          const result =
            action.action === "request_takeover"
              ? {...this.view(s), instruction: 'Return waiting without a question. The user can take over from Chat; returning control wakes this same assignment automatically. Do not report ready or create another task.'}
              : {...await this.snapshot(s),...(downloaded?{download:downloaded}:{})};
          record("complete", result);
          return result;
        } catch (error) {
          record("uncertain");
          throw error;
        }
      });
    })().finally(() => this.calls.delete(key));
    this.calls.set(key, { fingerprint, promise });
    return promise;
  }
  private async startRecording(s: Session, owner: WorkOwner, milliseconds = 60_000) {
    if (s.recording) throw new BrowserError('browser_recording_active', 'Finish the previous tab recording before starting another.');
    const tab = s.tabs.find(item => item.active) ?? s.tabs[0];
    if (!tab) throw new BrowserError('browser_recording_tab', 'Open a tab before starting a recording.');
    const id = randomUUID(), driver = this.driverFor(s);
    if (!driver.record) throw new BrowserError('browser_recording_unavailable', 'Tab recording requires the managed Roppo browser.');
    const recorder = await PageRecording.start(this.host.config.browser.ffmpegCommand, join(s.directory,'recordings',id),
      (path,signal) => driver.record!(s,tab.id,path,signal), milliseconds, s.controller.signal);
    const done = recorder.done.then(({bytes, ...details}) => ({id, ...details, recording:
      this.saveCapture(owner,'video/mp4',bytes,{url:tab.url,title:tab.title})}));
    void done.catch(() => {});
    s.recording = {recorder, done};
    return {id, state:'recording', tab:tab.id, durationMs:milliseconds};
  }
  private async stopRecording(s: Session) {
    const recording = s.recording;
    if (!recording) throw new BrowserError('browser_recording_inactive', 'This browser has no tab recording to stop.');
    void recording.recorder.stop().catch(() => {});
    try { return await recording.done; }
    finally { if(s.recording===recording)s.recording=undefined; }
  }
  async closeOwned(user: string, id: string, client: string, epoch: number) {
    const s = this.session(id, user);
    if (s.workspace) throw new BrowserError("browser_control_required","The workspace browser stays open.");
    if (s.control === "human") this.human(s, client, epoch);
    else if (s.control === "handoff")
      throw new BrowserError(
        "browser_control_busy",
        "Browser is changing control.",
      );
    await this.closeSession(s);
    return { closed: true };
  }
  private closeSession(s: Session, drain = true): Promise<void> {
    if (s.closePromise) return s.closePromise;
    s.closing = true;
    s.epoch++;
    s.controller.abort();
    s.stopFrames?.();
    return (s.closePromise = (async () => {
      await s.initialization?.catch(() => {});
      s.stopFrames?.();
      if (drain) await s.queue.catch(() => {});
      try {
        if(s.recording)await this.stopRecording(s).catch(() => {});
        await this.driverFor(s).close(s);
        rmSync(join(s.directory,'uploads'),{recursive:true,force:true});
        if (!s.personal) rmSync(s.directory, { recursive: true, force: true });
        const row = this.host.store.get<any>("browser-session", s.id);
        this.host.store.put("browser-session", s.id, { ...row, active: false });
      } finally {
        this.sessions.delete(s.id);
      }
    })());
  }
  endAssignment(ticketId: string, assignmentId: string) {
    for (const s of this.sessions.values())
      if (
        s.owner?.ticketId === ticketId &&
        s.owner.assignmentId === assignmentId
      ) {
        s.ended = true;
        s.epoch++;
        s.control = "ended";
        s.client = undefined;
        s.handoffReason = undefined;
        s.updatedAt = Date.now();
        if(s.recording)void this.stopRecording(s).catch(() => {});
      }
  }
  async close() {
    this.closing = true;
    clearInterval(this.timer);
    await this.recovery;
    await Promise.allSettled(
      [...this.sessions.values()].map((s) => this.closeSession(s)),
    );
    await Promise.allSettled([...this.opening.values()]);
    await Promise.allSettled([...this.calls.values()].map((c) => c.promise));
    await this.driver.shutdown?.();
  }
}
