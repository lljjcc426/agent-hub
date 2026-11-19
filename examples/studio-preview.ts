/**
 * Local design preview with its own account, database, files, and example model.
 * Run npm run build:chat, then tsx examples/studio-preview.ts [private directory].
 * Open the address in that directory's url.txt. It signs into this preview workspace.
 */
import {desktopChatFixture} from './chat-fixture-model.ts'
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { randomBytes, randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import type { RequestListener } from 'node:http';
import { configSchema, type Config } from '../src/config.ts';
import type { Model, ModelRequest } from '../src/model.ts';
import { Runtime } from '../src/runtime.ts';
import {MessageSource,bodyDigest} from '../src/sources.ts';
import {SourceRegistry} from '../src/source-plugins.ts';
import { serve } from '../src/server.ts';

process.umask(0o077);
const root = resolve(process.argv[2] ?? '.local/studio'),
  port = Number(process.env.ROPPO_PREVIEW_PORT ?? 4426);
const workspace = join(root, 'workspace');
mkdirSync(workspace, { recursive: true });
const privateFile = join(root, 'entry.json');
const login = existsSync(privateFile)
  ? JSON.parse(readFileSync(privateFile, 'utf8'))
  : {
      name: 'studio-preview',
      password: randomBytes(32).toString('hex'),
      path: '/open/' + randomBytes(20).toString('hex'),
    };
if (!existsSync(privateFile)) writeFileSync(privateFile, JSON.stringify(login), { mode: 0o600 });
const base = 'http://localhost:' + port;
const reasoningPreview = process.env.ROPPO_REASONING_PREVIEW === '1';
const config = configSchema.parse({
  stateDir: join(root, 'state'),
  port,
  work: { sandboxDriver: 'disabled', network: false },
  backends: {
    studio: {
      kind: 'openai-chat',
      label: '本地预览模型',
      baseUrl: base + '/preview-model/v1',
      model: 'studio-local',
    },
    ...(reasoningPreview ? {
      openai: {
        kind: 'openai-responses',
        label: 'OpenAI',
        baseUrl: 'https://api.openai.com/v1',
        model: 'gpt-6.1-terra',
        apiKeyEnv: 'ROPPO_STUDIO_NO_PROVIDER_KEY',
      },
    } : {}),
  },
  execution: {
    backend: 'studio',
    router: { mode: 'host', backend: 'studio', model: 'studio-local', label: 'Roppo', ...(reasoningPreview ? {effort:'high'} : {}) },
    management: { enabled: true, maxWorkers: 6 },
    workers: [
      { id: 'editor', label: '文档助手', backend: 'studio', model: 'studio-local' },
      { id: 'research', label: '资料助手', backend: 'studio', model: 'studio-local' },
      { id: 'review', label: '检查助手', backend: 'studio', model: 'studio-local' },
    ],
  },
  sources: [
    {id:'preview-room',kind:'preview-room',label:'示例工作群',cwd:workspace,allowedActors:['operator'],capabilities:{replies:true,events:false,resources:false}},
    {
      id: 'local',
      kind: 'local',
      cwd: workspace,
      allowedActors: ['operator'],
      workspace: { mode: 'source' },
    },
  ],
});
const checklist =
  '# 发布检查清单\n\n| 负责人 | 检查项 | 交付物 |\n| --- | --- | --- |\n| 文档助手 | 整理变更和使用说明 | 发布说明 |\n| 资料助手 | 核对文档链接与引用 | 链接清单 |\n| 检查助手 | 验证登录、对话和文件下载 | 验收记录 |\n';
const model: Model = {
  async run(request: ModelRequest) {
    const threadId = request.threadId ?? randomUUID(),
      turnId = randomUUID();
    request.onThread?.(threadId);
    request.onTurn?.(turnId);
    await wait(320, undefined, { signal: request.signal });
    if (request.role === 'worker') {
      if (request.activity?.workerId==='review' && !request.threadId) {
        const input=JSON.parse(request.input)
        const askedBy=input.inputs?.findLast((i:{kind:string;human?:boolean})=>i.kind==='trigger'&&i.human)?.triggerId??input.origin?.findLast((t:{human?:boolean})=>t?.human)?.id??null
        return {threadId,turnId,text:JSON.stringify({state:'blocked',summary:'发布说明已整理，等待确认语言。',question:'这份发布说明使用中文还是英文？',askedBy,reply:'发布说明的初稿已整理好。',handbacks:[],files:[],decision:{target:{label:'发布说明',version:'v1'},recipient:null,amount:null,validForSeconds:604800}})}
      }
      await request.onTool?.('superagent_progress', { summary: '正在整理发布检查项' }, turnId + '-progress');
      return {
        threadId,
        turnId,
        text: JSON.stringify({
          state: 'ready',
          summary: '已核对三项发布检查',
          reply: '发布说明、链接清单和验收记录已核对。',
          question: null,
          askedBy: null,
          handbacks: [],
        }),
      };
    }
    const input = JSON.parse(request.input),
      text = String(input.trigger?.text ?? '');
    let reply: string;
    if (input.kind !== 'user_message') reply = '协作结果已收到。发布前需要核对说明、链接和验收记录。';
    else if (/清单|checklist/i.test(text)) {
      const roster = await request.onTool?.('worker_manage', { action: 'list' }, turnId + '-team');
      const list = roster?.success ? JSON.parse(roster.contentItems[0]!.text!) : undefined;
      const editor = list?.workers?.find((w: { id: string }) => w.id === 'editor');
      if (editor)
        await request.onTool?.(
          'worker_manage',
          {
            action: 'assign',
            id: editor.id,
            revision: list.revision,
            requestId: turnId + '-editor',
            text: '核对发布说明、资料链接和验收范围。',
          },
          turnId + '-assign',
        );
      const file = await request.onTool?.(
        'chat_deliver_file',
        { name: '发布检查清单.md', content: checklist },
        turnId + '-file',
      );
      reply =
        '我把发布前的工作分成了三项。\n\n' +
        checklist.split('\n\n')[1] +
        (file?.success ? '\n清单已保存，可以打开或下载。' : '');
    } else if (/分工|团队|team|agent/i.test(text)) {
      const roster = await request.onTool?.('worker_manage', { action: 'list' }, turnId + '-team');
      const list = roster?.success ? JSON.parse(roster.contentItems[0]!.text!) : undefined;
      const workers = (list?.workers ?? []).map((w: { label?: string; id: string }) => w.label || w.id);
      reply = workers.length
        ? '当前有 ' +
          workers.length +
          ' 位协作成员：' +
          workers.join('、') +
          '。可以在「设置 → Agent 团队」调整成员和模型。'
        : '当前没有可用的协作成员。可以在「设置 → Agent 团队」添加。';
    } else if (/简报|brief/i.test(text)) {
      const content =
        '# 发布进度简报\n\n## 本次范围\n对话、设置和文件交付。\n\n## 发布前确认\n- 核对模型连接\n- 复查入口和权限\n- 验证文件下载\n';
      const file = await request.onTool?.(
        'chat_deliver_file',
        { name: '发布进度简报.md', content },
        turnId + '-file',
      );
      reply = file?.success ? '简报草稿已保存。可以打开文件查看本次范围和发布前的确认事项。' : content;
    } else reply = '收到你的消息。这个预览使用本地示例模型，可以整理发布清单、查看团队分工，也可以起草简报。';
    const raw = JSON.stringify({ reply });
    request.onOutput?.({ id: turnId, type: 'start', phase: 'answer' });
    for (let i = 0; i < raw.length; i += 12) {
      request.onOutput?.({ id: turnId, type: 'delta', phase: 'answer', text: raw.slice(i, i + 12) });
      await wait(35, undefined, { signal: request.signal });
    }
    return { threadId, turnId, text: raw };
  },
};
const registry=new SourceRegistry()
registry.register({apiVersion:1,kind:'preview-room',label:'示例工作群',create:c=>new class extends MessageSource {
 async deliver(message:Parameters<MessageSource['deliver']>[0]){return {providerAccepted:true as const,messageId:message.id,thread:message.channel.thread,remoteMessageId:'preview-'+message.id,contentDigest:bodyDigest(message.text)}}
}(c)})
const createRuntime = (c: Config) => new Runtime(c, { model: desktopChatFixture(model, '我先查看这次协作需要的材料。'), sourceRegistry:registry });
const runtime = createRuntime(config);
// The local preview uses the same private Chat memory path as a configured workspace.
// A preview with older tickets requires the normal ownership migration.
if (!runtime.scopes.enabled() && !runtime.store.tickets.list().length && !runtime.store.get('scope-migration', 'current')) {
  runtime.scopes.command({
    action: 'scope.put', operationId: 'studio-preview-workspace', expectedRevision: 0,
    scope: {
      id: 'studio-preview', tenantId: 'studio-preview', name: 'Roppo Studio',
      managers: [JSON.stringify(['local', 'operator'])], sourceIds: ['local'],
      workerIds: (config.execution.workers ?? []).map(worker => worker.id), backendIds: ['studio'],
    },
  });
}
const host = await serve(runtime, { createRuntime, clientHome: join(root, 'client-home') });

const token = readFileSync(host.tokenPath, 'utf8').trim();
async function signin(setup = false) {
  const response = await fetch(base + (setup ? '/account/setup' : '/account/login'), {
    method: 'POST',
    headers: {
      origin: base,
      'content-type': 'application/json',
      ...(setup ? { authorization: 'Bearer ' + token } : {}),
    },
    body: JSON.stringify({
      username: login.name,
      password: login.password,
      ...(setup ? { displayName: 'Roppo Studio' } : {}),
      remember: true,
    }),
  });
  if (!response.ok) throw Error('Preview sign-in failed: ' + response.status);
  return response.headers.get('set-cookie')!;
}
const isNew = !((await (await fetch(base + '/account/status')).json()) as { configured: boolean }).configured;
const cookie = await signin(isNew);
if (isNew) {
  const response = await fetch(base + '/api/chat/space', {
    method: 'PATCH',
    headers: { cookie: cookie.split(';')[0]!, origin: base, 'content-type': 'application/json' },
    body: JSON.stringify({ display: 'agents' }),
  });
  if (!response.ok) throw Error('Could not initialize preview workspace');
}
const account=await (await fetch(base+'/account/status',{headers:{cookie:cookie.split(';')[0]!}})).json()
const owner=account.user.id
let sample=runtime.store.get<{chatId:string}>('preview-sample','review')
if(!sample){
 const chat=runtime.chat.create(owner)
 const sent=runtime.chat.send(chat.id,owner,{clientMessageId:randomUUID(),text:'请整理发布说明，并和我确认语言。'})
 const trigger=runtime.store.triggers.get(sent.runId)!,discussion='local:chat:'+chat.id,scoped=runtime.scopes.context(trigger,discussion)!
 const manifest=runtime.memory.build(scoped,{request:'整理发布说明'},'studio').manifest
 const assignment=await runtime.manager.call({action:'assign',id:'review',revision:runtime.settings.current().revision,requestId:'preview-question',text:'确认发布说明语言'},{discussion,trigger,scoped,manifest})
 const evidence=runtime.memory.ingest(scoped)
 for(const [category,content] of [['project_decision','发布说明采用一页摘要，附上完整变更记录。'],['preference','对话中优先使用中文。']] as const){
  runtime.memory.command(scoped,{action:'remember',operationId:'sample-'+category,expectedRevision:0,subject:category==='preference'?'交流语言':'发布说明',content,sourceIds:[evidence.id],category,candidate:false,...(category==='project_decision'?{ticketId:assignment.ticketId}:{})},true)
 }
 runtime.store.outbox.send({id:'release-01',kind:'reply',text:'发布检查已完成',channel:{source:'preview-room',thread:'release',address:{}}})
 await runtime.flush()
 sample={chatId:chat.id};runtime.store.put('preview-sample','review',sample)
}
runtime.start()
const [normal] = host.server.listeners('request') as RequestListener[];
if (!normal || host.server.listenerCount('request') !== 1) throw Error('Unexpected server layout');
host.server.removeListener('request', normal);
host.server.on('request', (req, res) => {
  if (req.headers.host === new URL(base).host) {
    if (req.url?.split('?')[0] === login.path && req.method === 'GET') {
      void signin()
        .then((session) => {
          res.writeHead(303, {
            'set-cookie': session,
            location: req.url?.endsWith('?memory')?'/configure#advanced/memory':req.url?.endsWith('?receipts')?'/configure#connections':'/chat#conversation/'+sample!.chatId,
            'referrer-policy': 'no-referrer',
            'cache-control': 'no-store',
          });
          res.end();
        })
        .catch(() => {
          res.writeHead(503);
          res.end('Preview unavailable');
        });
      return;
    }
    if (req.url === '/preview-model/v1/models' && req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          object: 'list',
          data: reasoningPreview ? [
            { id: 'studio-local', effort: {supported_levels:['low','high','max'],default_level:'high'} },
            { id: 'studio-fast', effort: {supported_levels:['none','minimal','low'],default_level:'low'} },
            { id: 'studio-default' },
          ] : [{ id: 'studio-local', object: 'model', owned_by: 'studio',
            effort: {supported_levels:['low','medium','high'],default_level:'medium'} }],
        }),
      );
      return;
    }
    if (req.url === '/preview-model/v1/chat/completions' && req.method === 'POST') {
      req.resume();
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          id: randomUUID(),
          object: 'chat.completion',
          model: 'studio-local',
          choices: [
            {
              index: 0,
              finish_reason: 'stop',
              message: { role: 'assistant', content: JSON.stringify({ ok: true }) },
            },
          ],
        }),
      );
      return;
    }
  }
  normal.call(host.server, req, res);
});
writeFileSync(join(root, 'url.txt'), base + login.path + '\n', { mode: 0o600 });
console.log('Workspace preview ready on ' + base);
async function close() {
  host.server.closeAllConnections();
  await new Promise<void>((ok) => host.server.close(() => ok()));
  await host.closeRuntime();
}
process.once('SIGINT', () => void close());
process.once('SIGTERM', () => void close());
