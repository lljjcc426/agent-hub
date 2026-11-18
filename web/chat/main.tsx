import '../../src/ui/tab-motion.js';
import '../../src/ui/tab-motion.css';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { createRoot } from "react-dom/client";
import {
  AssistantRuntimeProvider,
  useExternalStoreRuntime,
  ThreadPrimitive,
  MessagePrimitive,
  ComposerPrimitive,
  useAui,
  useAuiState,
  useMessagePartText,
  type ThreadMessageLike,
} from "@assistant-ui/react";

import {
  ArrowUp,
  ArrowDown,
  Users,
  SlidersHorizontal,
  Sun,
  Moon,
  PanelRight,
  Menu,
  X,
  ChevronDown,
  ChevronRight,
  Check,
  LoaderCircle,
  Square,
  Paperclip,
  AlertCircle,
  RefreshCw,
  Wrench,
  Globe,
  Hand,
} from "lucide-react";
import type { ChatSessions } from "../../src/chat.ts";
import {DeliveryCard,FileViewer,TeamOverview,type TeamTab} from './team-view.tsx';
import type {ChatDelivery} from '../../src/chat-deliveries.ts';
import {WorkflowProvider,WorkflowCards,RouterDecision,FileReviewCard,groupWorkflow} from './workflow-cards.tsx';
import {CommandInput, type ChatCommand} from './composer-commands.tsx';
import {ContextCard} from './context-card.tsx';
import {ToolCallCard} from '../ui/agent-team.tsx';
import {SwitchView,switchView} from '../ui/transitions.tsx';
import '../ui/theme.css';
import '../ui/components.css';
import '../ui/agent-components.css';
import '../ui/transitions.css';
import './workflow.css';
import { ResourceWorkspace } from "./resource-workspace.tsx";
import { initialResources, openResource, resourceKey, type ResourceKind } from "./resource-state.ts";
import { FeatureNavigation } from "./navigation.tsx";
import {lazy,Suspense} from "react";
const PluginMarketplace=lazy(()=>import("./plugin-marketplace.tsx").then(m=>({default:m.PluginMarketplace})));
const AutomationWorkspace=lazy(()=>import("./automations.tsx").then(m=>({default:m.AutomationWorkspace})));
import {spaceRequest,clearChatDrafts,type ChatSpace} from './chat-settings.tsx';
import { Configuration } from "./configuration.tsx";
import {WorkspaceView,useWorkspaceViews} from './workspace-view.tsx';
import { FilesPanel } from "./files.tsx";
import { AgentAvatar } from "./agent-avatar.tsx";
import {RouterModelControl} from './router-model.tsx';

import {ChatCompanion} from "./companion.tsx";
import {companionStatus} from "./companion-state.ts";
import {InteractionProvider,MessageActions,Reactions,QuotePreview,QuotedMessage,type DraftQuote} from './message-interactions.tsx';
import {useChatMotion} from './chat-motion.ts';
import type {ChatQuote,ChatQuoteView} from '../../src/chat-interactions.ts';
import {attachmentError,attachmentParts,createAttachmentAdapter,DraftAttachment,MessageAttachments} from './attachments.tsx';
import type {ChatAttachment} from '../../src/chat-attachments.ts';
const RichMarkdown=lazy(()=>import("./markdown.tsx"));
import "../../src/ui/theme.css";
import "../../src/ui/typography.css";
import "./style.css";
import "./rich-content.css";
import "./navigation.css";
import "./chat-layout.css";
import "./message-interactions.css";
import "./team-view.css";

type Snapshot = ReturnType<ChatSessions["view"]>;
type Conversation = Snapshot["conversation"];
type Ready = Snapshot["readiness"] & { user?: { displayName: string } };
type Worker = Snapshot["workers"][number];
type Language = "en" | "zh-CN";
type Arrivals = {conversationId:string;since:number;seen:Set<string>};
const read = (key: string, fallback = "") => {
  try {
    return localStorage.getItem(key) ?? fallback;
  } catch {
    return fallback;
  }
};
const write = (key: string, value: string) => {
  try {
    localStorage.setItem(key, value);
  } catch {}
};
const draftKey = (id: string | null) => "roppo.chat.draft." + (id ?? "new");
const pendingKey = (id: string) => "roppo.chat.pending." + id;
function savedPending(
  id: string | null,
): { text: string; id: string; conversationId: string;attachments?:string[];quote?:ChatQuote } | null {
  try {
    const value = id ? JSON.parse(read(pendingKey(id), "null")) : null;
    return value &&
      typeof value.text === "string" &&
      typeof value.id === "string" &&
      value.conversationId === id
      ? value
      : null;
  } catch {
    return null;
  }
}
const quoteKey=(id:string|null)=>"roppo.chat.draft.quote."+(id??"new");
function savedQuote(id:string|null):DraftQuote|null {
  try{return JSON.parse(read(quoteKey(id),'null'))}catch{return null}
}
const quoteReference=(quote:DraftQuote|null):ChatQuote|undefined=>quote?{messageId:quote.messageId,...(quote.excerpt?{excerpt:quote.excerpt}:{})}:undefined;
class ApiError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}
async function api<T>(
  path: string,
  body?: unknown,
  method = "POST",
  signal?: AbortSignal,
): Promise<T> {
  const response = await fetch("/api/chat" + path, {
    credentials: "same-origin",
    ...(body !== undefined
      ? {
          method,
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        }
      : {}),
    ...(signal ? { signal } : {}),
  });
  if (response.status === 401) {
    location.assign("/chat" + location.search);
    throw new ApiError("login_required");
  }
  const result = await response.json();
  if (!response.ok) throw new ApiError(result.code ?? "request_failed");
  return result;
}
const loadContext=(id:string,signal:AbortSignal,activity?:string)=>api<ReturnType<ChatSessions["contextUsage"]>>("/conversations/"+id+"/context"+(activity?'?activity='+encodeURIComponent(activity):''),undefined,"GET",signal);
const Context = createContext({
  lang: "en" as Language,
  L: (en: string, zh: string) => en,
  workers: [] as Worker[],
  routerLabel: 'Router',
  openFile: (_file:ChatDelivery)=>{},
  openWorker: (_id:string)=>{},
  workerView:false,
  run: null as Snapshot['run'],
  runMessageId: '',
  arrivals: {since: Infinity, seen: new Set<string>()},
});
const useUI = () => useContext(Context);
function IconButton({
  label,
  children,
  ...props
}: {
  label: string;
  children: ReactNode;
} & React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      type="button"
      className="icon-button"
      title={label}
      aria-label={label}
      {...props}
    >
      {children}
    </button>
  );
}
function ErrorNotice({ code, clear }: { code: string; clear: () => void }) {
  const { L } = useUI();
  const message =
    code==='message_missing'?L('The original message is no longer available.','原消息已不可用。'):
    code==='quote_changed'?L('The selected text changed. Please quote it again.','选中的内容已变化，请重新引用。'):
    code==='reaction_failed'?L('Reaction wasn’t saved. Try again.','表情未保存，请重试。'):
    code.startsWith("attachment_")?attachmentError(code,L):
    code==='sent_refresh_failed'?L('Message sent. Refresh to see the latest replies.','消息已发送，请刷新查看最新回复。'):
    code === "conversation_busy"
      ? L("This conversation is still running.", "当前会话仍在运行。")
      : code === "conversation_missing"
        ? L("This conversation is unavailable.", "此会话暂不可用。")
        : code === "chat_entry_unavailable"
          ? L("This Chat entry is unavailable. Check its entry settings.", "当前 Chat 入口不可用，请检查会话入口设置。")
        : code === "request_not_admitted"
          ? L("The current entry rules did not accept this message.", "消息未被当前入口规则接收，请检查会话入口设置。")
          : code === "message_conflict"
            ? L(
                "This message changed. Please send it again.",
                "消息内容已改变，请重新发送。",
              )
            : code === "merge_in_progress"
              ? L(
                  "A merge is in progress. Check it in Tasks before stopping.",
                  "合并正在进行，请先在任务页核对结果。",
                )
              : L(
                  "Couldn’t complete this action. Your draft is saved.",
                  "操作未完成，草稿已保留。",
                );
  return (
    <div className="notice error" role="alert">
      <AlertCircle size={17} />
      <span>{message}</span>
      <IconButton label={L("Dismiss", "关闭")} onClick={clear}>
        <X size={16} />
      </IconButton>
    </div>
  );
}
function SendMessage({sending,consume}:{sending:boolean;consume:()=>boolean}){
  const {L}=useUI(),aui=useAui();
  const canSend=useAuiState(s=>!s.thread.isDisabled&&s.composer.canSend);
  return <button type="button" className="send-button" disabled={!canSend} aria-label={L('Send message','发送消息')} onClick={()=>{if(!consume())aui.composer.send()}}>
    {sending?<LoaderCircle size={18} className="spin"/>:<ArrowUp size={20}/>}
  </button>;
}
function useArrival(id: string, createdAt: number) {
  const { arrivals } = useUI();
  const [fresh] = useState(() => createdAt >= arrivals.since && !arrivals.seen.has(id));
  useEffect(() => { arrivals.seen.add(id); }, [arrivals, id]);
  return fresh || undefined;
}
function Timestamp({ at }: { at: Date | number }) {
  const { lang } = useUI(), date = new Date(at);
  return <time className="message-time" dateTime={date.toISOString()} title={new Intl.DateTimeFormat(lang, {dateStyle:'medium', timeStyle:'medium'}).format(date)}>{new Intl.DateTimeFormat(lang, {hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).format(date)}</time>;
}
function runLabel(state: string, L: (en: string, zh: string) => string) {
  return ({queued:L('Waiting for Router','等待 Router'),running:L('Working','处理中'),waiting:L('Waiting for your input','等待你的补充'),completed:L('Complete','已完成'),cancel_requested:L('Stopping…','正在停止…'),cancelled:L('Stopped','已停止'),failed:L('Couldn’t finish. Send a follow-up to retry.','未能完成，可补充消息后重试。')} as Record<string,string>)[state];
}
function UserMessage() {
  const { L } = useUI(),
    id = useAuiState((s) => s.message.id),
    attachments = useAuiState((s) => s.message.metadata.custom?.attachments) as ChatAttachment[]|undefined,
    hasText = useAuiState((s) => s.message.content.some(c=>c.type==='text'&&!!c.text)),
    createdAt = useAuiState((s) => s.message.createdAt),
    arrival = useArrival(id, createdAt.getTime());
  return (
    <>
      <MessagePrimitive.Root className="message user-message" data-arrival={arrival}>
        <UserQuote/>
        <MessageAttachments files={attachments??[]} L={L}/>
        {hasText?<div className="user-bubble" data-message-body><MessagePrimitive.Parts components={{Text:Markdown}}/></div>:null}
        <Reactions id={id}/>
        <div className="message-footer"><MessageActions id={id}/><Timestamp at={createdAt}/></div>
      </MessagePrimitive.Root>
      <WorkflowCards anchor={id}/>
    </>
  );
}
function UserQuote(){const quote=useAuiState(s=>s.message.metadata.custom?.quote) as ChatQuoteView|undefined;return <QuotedMessage quote={quote}/>}
function ComposerAttachment(){const {L}=useUI();return <DraftAttachment L={L}/>}
function PlainText(){const {text}=useMessagePartText();return <span>{text}</span>}
function Markdown(){
  const { L } = useUI();
  const files = useAuiState(s => s.message.metadata.custom?.linkFiles) as ChatDelivery[] | undefined;
  return <Suspense fallback={<PlainText/>}><RichMarkdown L={L} files={files}/></Suspense>
}
function AssistantMessage() {
  const { L, run, runMessageId, routerLabel, openFile,openWorker,workerView,workers } = useUI(),
    deliveries=useAuiState(s=>s.message.metadata.custom?.deliveries) as ChatDelivery[]|undefined,
    decision=useAuiState(s=>s.message.metadata.custom?.decision) as Snapshot["messages"][number]["decision"],
    fileReview=useAuiState(s=>s.message.metadata.custom?.fileReview) as (NonNullable<Snapshot["messages"][number]["fileReview"]> & {name:string})|undefined,
    ticketId=useAuiState(s=>s.message.metadata.custom?.ticketId) as string|undefined,
    id = useAuiState((s) => s.message.id),
    attachments = useAuiState((s) => s.message.metadata.custom?.attachments) as ChatAttachment[]|undefined,
    createdAt = useAuiState((s) => s.message.createdAt),
    arrival = useArrival(id, createdAt.getTime()),
    speaker = useAuiState((s) => s.message.metadata.custom?.speaker) as Snapshot["participants"][number]|undefined,
    recipient = useAuiState((s) => s.message.metadata.custom?.recipient) as Snapshot["participants"][number]|undefined,
    status = useAuiState((s) => s.message.status),
    hasText = useAuiState((s) =>
      s.message.content.some((c) => c.type === "text" && !!c.text),
    ),
    streaming = status?.type === "running";
  if (streaming && !hasText) return null;
  const assignee=recipient?.kind==='worker'&&workers.find(w=>w.id===recipient.id);
  const task=assignee&&assignee.tasks.find(t=>t.id===ticketId);
  if(!workerView&&task&&assignee)return <><MessagePrimitive.Root className="message team-trace" data-arrival={arrival}>
    <button onClick={()=>openWorker(assignee.id)} title={L('View collaboration','查看协作记录')}><AgentAvatar id={assignee.id} kind="worker" size={22}/>
      <strong>{assignee.label}</strong><span>{task.title}</span><ChevronRight size={14}/></button>
    <Timestamp at={createdAt}/>
  </MessagePrimitive.Root><WorkflowCards anchor={id}/></>;
  let body: ReactNode;
  if (deliveries?.length) {
    body = deliveries.map(file => <DeliveryCard key={file.id} L={L} file={file} open={openFile}/>);
  } else if (fileReview) {
    body = <FileReviewCard key={id} id={id} name={fileReview.name} review={fileReview}/>;
  } else if (decision) {
    body = <RouterDecision id={id} decision={decision}/>;
  } else {
    body = <div data-message-body><MessagePrimitive.Parts components={{ Text: Markdown }}/></div>;
  }
  return (
    <><MessagePrimitive.Root
      className="message assistant-message"
      data-arrival={arrival}
      data-streaming={streaming ? "true" : undefined}
    >
      <div className="assistant-identity">
        <AgentAvatar id={speaker?.id} kind={speaker?.kind} size={32} />
        <strong>{speaker?.label ?? routerLabel}</strong>
        {speaker && speaker.label !== (speaker.kind === "worker" ? "Worker" : "Router") ? <span className="agent-role">{speaker.kind === "worker" ? "Worker" : "Router"}</span> : null}
        {recipient ? <span className="message-recipient">→ {recipient.label}</span> : null}
        <Timestamp at={createdAt}/>
        {streaming ? (
          <span className="output-state">
            <span className="live-dot" />
            {L("Writing", "正在输出")}
          </span>
        ) : null}
      </div>
      <div className="assistant-body">
        {body}
        <MessageAttachments files={attachments??[]} L={L}/>
        <Reactions id={id}/>
        <div className="message-footer">
          {run && runMessageId === id ? <span className={'message-status ' + run.state} role="status"><StatusIcon state={run.state} />{runLabel(run.state, L)}</span> : status?.type === 'incomplete' ? <span className="message-status">{status.reason === 'cancelled' ? L('Output stopped','输出已停止') : L('Output interrupted','输出中断')}</span> : null}
        <MessageActions id={id}/>
        </div>
      </div>
    </MessagePrimitive.Root><WorkflowCards anchor={id}/></>
  );
}
function StatusIcon({ state }: { state: string }) {
  return state === "running" || state === "queued" ? (
    <LoaderCircle className={state === "running" ? "spin" : ""} size={17} />
  ) : state === "completed" ? (
    <Check className="success" size={17} />
  ) : ["waiting", "failed", "interrupted"].includes(state) ? (
    <AlertCircle size={17} />
  ) : state === "cancelled" ? (
    <Square size={12} />
  ) : (
    <span className="idle-dot" />
  );
}
function ToolCalls({
  calls,
  workers,
}: {
  calls: Snapshot["calls"];
  workers: Worker[];
}) {
  const { L,lang,routerLabel,arrivals } = useUI(),
    arrival = useArrival('tools:' + calls[0]!.runId, calls[0]!.startedAt),
    [open, setOpen] = useState(false),
    [now, setNow] = useState(Date.now()),
    tools = calls,
    busy = tools.some((c) => c.state === "running");
  useEffect(() => {
    if (!busy) return;
    const timer = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(timer);
  }, [busy]);
  if (!tools.length) return null;
  const names: Record<string, string> = {
    list: L("Inspect team", "查看团队"),
    assign: L("Delegate task", "分派任务"),
    send: L("Continue task", "继续任务"),
    result: L("Read result", "读取结果"),
    inspect: L("Inspect task", "查看任务"),
    create: L("Create worker", "创建 Worker"),
    configure: L("Configure worker", "配置 Worker"),
    set_prompt: L("Set instructions", "设置提示词"),
    clone: L("Clone worker", "复制 Worker"),
    retire: L("Retire worker", "停用 Worker"),
    destroy: L("Remove worker", "移除 Worker"),
    migrate: L("Migrate worker", "迁移 Worker"),
    cancel: L("Cancel task", "取消任务"),
    pause: L("Pause worker", "暂停 Worker"),
    resume: L("Resume worker", "恢复 Worker"),
    remove: L("Remove worker", "移除 Worker"),
    stop: L("Stop task", "停止任务"),
    superagent_read: L("Read resource", "读取资源"),
    superagent_shell: L("Run command", "执行命令"),
    superagent_job: L("Inspect background job", "查看后台任务"),
    superagent_spawn: L("Delegate subtask", "分派子任务"),
    superagent_progress: L("Update progress", "更新进展"),
    superagent_tool: L("Call connected tool", "调用连接工具"),
    superagent_tools: L("Inspect tools", "查看工具"),
  };
  Object.assign(names, {
    workspace_browser: L("Workspace browser", "工作区浏览器"),
    superagent_browser: L("Use browser", "\u64cd\u4f5c\u6d4f\u89c8\u5668"),
    "browser:profiles": L(
      "Read browser profiles",
      "\u67e5\u770b\u6d4f\u89c8\u5668\u8d44\u6599",
    ),
    "browser:open": L("Open browser", "\u6253\u5f00\u6d4f\u89c8\u5668"),
    "browser:navigate": L("Open website", "\u6253\u5f00\u7f51\u7ad9"),
    "browser:snapshot": L("Read page", "\u8bfb\u53d6\u9875\u9762"),
    "browser:click": L(
      "Click page element",
      "\u70b9\u51fb\u9875\u9762\u5143\u7d20",
    ),
    "browser:fill": L("Fill field", "\u586b\u5199\u5185\u5bb9"),
    "browser:press": L("Press key", "\u6309\u952e\u64cd\u4f5c"),
    "browser:scroll": L("Scroll page", "\u6eda\u52a8\u9875\u9762"),
    "browser:login": L(
      "Fill saved account",
      "\u586b\u5165\u5df2\u4fdd\u5b58\u8d26\u53f7",
    ),
    "browser:request_takeover": L(
      "Request takeover",
      "\u8bf7\u6c42\u4eba\u5de5\u63a5\u7ba1",
    ),
    "browser:close": L("Close browser", "\u5173\u95ed\u6d4f\u89c8\u5668"),
    "browser:new_tab": L("Open tab", "\u65b0\u5efa\u6807\u7b7e\u9875"),
    "browser:select_tab": L("Switch tab", "\u5207\u6362\u6807\u7b7e\u9875"),
    "browser:close_tab": L("Close tab", "\u5173\u95ed\u6807\u7b7e\u9875"),
    "browser:back": L("Go back", "\u540e\u9000"),
    "browser:forward": L("Go forward", "\u524d\u8fdb"),
    "browser:reload": L("Reload page", "\u91cd\u65b0\u52a0\u8f7d"),
  });
  const states: Record<string, string> = {
    running: L("Running", "运行中"),
    completed: L("Complete", "已完成"),
    failed: L("Failed", "失败"),
    interrupted: L("Interrupted", "已中断"),
  };
  return (
    <details
      className="tool-activity"
      data-arrival={arrival}
      open={open}
      onToggle={(e) => setOpen(e.currentTarget.open)}
    >
      <summary>
        <Wrench size={15} />
        <strong>{L("Tool calls", "工具调用")}</strong>
        <span>{tools.length}</span>
        <ChevronDown size={14} />
      </summary>
      <ToolCallCard L={L} showHeading={false} calls={tools.map(call=>{
        const actor=workers.find(w=>w.id===call.workerId)?.label??call.workerId??routerLabel;
        const target=workers.find(w=>w.id===call.target)?.label??call.target;
        const name=names[call.action??call.name]??call.name;
        return {id:call.id,arrival:call.startedAt>=arrivals.since,name:target?name+' · '+target:name,summary:actor+' · '+states[call.state],
          status:({running:'working',completed:'done',failed:'error',interrupted:'paused'} as const)[call.state],
          timestamp:new Intl.DateTimeFormat(lang,{hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).format(call.startedAt),
          elapsed:(Math.max(0,(call.endedAt??now)-call.startedAt)/1000).toFixed(1)+'s',
          details:[[L('Tool','工具'),call.name],[L('Status','状态'),states[call.state]!],...(call.action?[[L('Action','操作'),call.action] as [string,string]]:[]),...(target?[[L('Target','目标'),target] as [string,string]]:[])]};
      })}/>
    </details>
  );
}
function Readiness({ ready }: { ready: Ready | null }) {
  const { L } = useUI();
  if (!ready || ready.ready) return null;
  const messages: Record<string, string> = {
    host_router_required: L(
      "Enable a host Router to start chatting here.",
      "启用托管 Router 后即可在这里对话。",
    ),
    host_paused: L("The host is paused.", "运行已暂停。"),
    local_source_required: L(
      "Add a local conversation entry.",
      "请添加本地会话入口。",
    ),
    model_credentials_missing: L(
      "Connect your Router model.",
      "请连接 Router 模型。",
    ),
    model_unavailable: L(
      "Your Router model is unavailable.",
      "Router 模型暂不可用。",
    ),
    preview_restricted: L(
      "This preview cannot run tasks.",
      "此预览不执行任务。",
    ),
  };
  return (
    <div className="notice readiness">
      <AlertCircle size={18} />
      <span>
        {messages[ready.code] ??
          L("Configure your Router to begin.", "配置 Router 后开始。")}
      </span>
      <a
        href={
          ready.code === "host_paused"
            ? "/configure#advanced/host"
            : ready.configurationUrl
        }
      >
        {L("Configure Router", "配置 Router")}
        <ChevronRight size={15} />
      </a>
    </div>
  );
}
function App() {
  const chatArrivals = useRef<Arrivals>({conversationId:'',since:Infinity,seen:new Set()});

  const [route, setRoute] = useState(
    location.pathname + location.search + location.hash,
  );
  const [id, setId] = useState<string | null>(null),
    [display, setDisplay] = useState<ChatSpace["display"]>("group"),
    [ready, setReady] = useState<Ready | null>(null);
  const [navExpanded, setNavExpanded] = useState(read("roppo.navigation.expanded") === "true");
  useEffect(() => write("roppo.navigation.expanded", String(navExpanded)), [navExpanded]);
  const [lang, setLang] = useState<Language>(
      read("agenthub.configuration.language") === "zh-CN" ? "zh-CN" : "en",
    ),
    [dark, setDark] = useState(read("agenthub.configuration.theme") === "dark");
  const L = useCallback(
    (en: string, zh: string) => (lang === "zh-CN" ? zh : en),
    [lang],
  );
  const spaceVersion=useRef(0);
  const refreshList = useCallback(async () => {
    const version=++spaceVersion.current,space=await spaceRequest();if(version!==spaceVersion.current)return;
    if(space.cleanup && read("roppo.chat.reset") !== space.cleanup.id){clearChatDrafts();write("roppo.chat.reset",space.cleanup.id)}
    setId(space.conversation?.id??null);setDisplay(space.display);
  }, []);
  useEffect(()=>{const change=()=>void refreshList();window.addEventListener('roppo:chat-space',change);return()=>window.removeEventListener('roppo:chat-space',change)},[refreshList]);
  const navigate = useCallback((next: string | null) => {
    setId(next);
    const url = new URL("/chat", location.origin);

    history.pushState(null, "", url);
    switchView("page",()=>setRoute(url.pathname + url.search + url.hash));
  }, []);
  useEffect(() => {
    const sync = () => {
      if (location.hash === "#prompts/memory") history.replaceState(null, "", location.pathname + location.search + "#advanced/memory");
      if (location.pathname === "/chat" && location.search) history.replaceState(null, "", "/chat" + location.hash);
      const next=location.pathname+location.search+location.hash;
      switchView("page",()=>setRoute(next));
    };
    const click = (event: MouseEvent) => {
      if (
        event.defaultPrevented ||
        event.button ||
        event.metaKey ||
        event.ctrlKey ||
        event.shiftKey ||
        event.altKey
      )
        return;
      const anchor = (event.target as Element).closest?.(
        "a[href]",
      ) as HTMLAnchorElement | null;
      if (
        !anchor ||
        anchor.target ||
        anchor.hasAttribute("download") ||
        anchor.getAttribute("href")?.startsWith("#")
      )
        return;
      const url = new URL(anchor.href);
      if (
        url.origin !== location.origin ||
        !["/configure", "/configure/", "/chat"].includes(url.pathname)
      )
        return;
      event.preventDefault();
      if (url.pathname === "/chat") url.search = "";
      history.pushState(null, "", url);
      sync();
    };
    sync();
    document.addEventListener("click", click);
    window.addEventListener("popstate", sync);
    window.addEventListener("hashchange", sync);
    window.addEventListener("roppo:navigation", sync);
    return () => {
      document.removeEventListener("click", click);
      window.removeEventListener("popstate", sync);
      window.removeEventListener("hashchange", sync);
      window.removeEventListener("roppo:navigation", sync);
    };
  }, [id]);
  useEffect(() => {
    let alive = true;
    api<Ready>("/readiness")
      .then((r) => {
        if (alive) setReady(r);
      })
      .catch(() => {});
    refreshList().catch(() => {});
    const timer = setInterval(() => {
      api<Ready>("/readiness")
        .then((r) => {
          if (alive) setReady(r);
        })
        .catch(() => {});
      refreshList().catch(() => {});
    }, 10000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [refreshList]);
  useEffect(() => {
    document.documentElement.dataset.theme = dark ? "dark" : "light";
    write("agenthub.configuration.theme", dark ? "dark" : "light");
  }, [dark]);
  useEffect(() => {
    document.documentElement.lang = lang;
    write("agenthub.configuration.language", lang);
  }, [lang, L]);
  useEffect(() => {
    const storage = (e: StorageEvent) => {
      if (e.key === "agenthub.configuration.theme")
        setDark(e.newValue === "dark");
      if (e.key === "agenthub.configuration.language")
        setLang(e.newValue === "zh-CN" ? "zh-CN" : "en");
    };
    window.addEventListener("storage", storage);
    return () => window.removeEventListener("storage", storage);
  }, []);
  return (
    <>
      <div
        id="announcer"
        className="sr-only"
        role="status"
        aria-live="polite"
      />
      <Chat
        arrivals={chatArrivals}
        refreshReady={async()=>setReady(await api<Ready>("/readiness"))}
        key={id ?? "new"}
        {...{
          id,
          display,
          ready,
          lang,
          L,
          dark,
          setDark,
          navigate,
          refreshList,
          setLang,
          route,
          navExpanded,
          setNavExpanded,
        }}
      />
    </>
  );
}
type ChatProps = {
  arrivals: React.RefObject<Arrivals>;
  refreshReady: () => Promise<void>;
  navExpanded: boolean;
  setNavExpanded: (value: boolean) => void;
  display: ChatSpace["display"];
  route: string;
  id: string | null;
  ready: Ready | null;
  lang: Language;
  L: (en: string, zh: string) => string;
  dark: boolean;
  setDark: (v: boolean) => void;
  navigate: (id: string | null) => void;
  refreshList: () => Promise<void>;
  setLang: (v: Language) => void;
};
const emptySidebarCards: { items: ChatCommand[]; revealing: boolean } = { items: [], revealing: false };
function Chat(p: ChatProps) {
  const {
    id,
    display,
    ready: boot,
    lang,
    L,
    dark,
    setDark,
    navigate,
    refreshList,
    setLang,
    route,
    navExpanded,
    setNavExpanded,
  } = p;
  const configuring = !route.startsWith("/chat");
  const [resources, setResources] = useState(() =>
    initialResources(read(resourceKey(id)), read("roppo.chat.panel." + (id ?? "new"))),
  );
  const activeTool = resources.tabs.find(tab => tab.id === resources.active)!.kind;
  const lastView = resources.view === 'team' ? 'activity' : activeTool;
  const resource = resources.visible ? lastView : null;
  const [sidebarCards, setSidebarCards] = useState(emptySidebarCards);
  const panel = sidebarCards.revealing ? 'activity' : resource;
  const overview = panel === 'activity';
  useEffect(() => { if (configuring) setSidebarCards(emptySidebarCards); }, [configuring]);
  const [pendingWebsite, setPendingWebsite] = useState(() => {
    try { return sessionStorage.getItem("roppo.website." + id) || ""; } catch { return ""; }
  });
  const consumeWebsite = () => {
    setPendingWebsite("");
    try { sessionStorage.removeItem("roppo.website." + id); } catch {}
  };
  useEffect(() => write(resourceKey(id), JSON.stringify(resources)), [id, resources]);
  const [teamTab,setTeamTab]=useState<TeamTab>('activity'),[file,setFile]=useState<ChatDelivery|null>(null);
  const [browserRequest,setBrowserRequest]=useState<{id:string;takeover:boolean;key:number}>();
  const [panelExpanded, setPanelExpanded] = useState(false),
    [pickerRequest, setPickerRequest] = useState(0);
  const creating = useRef(false);
  const choosePanel = async (next: ResourceKind | null, url?: string) => {
    if (next === "browser" && !id) {
      if (creating.current) return;
      creating.current = true;
      try {
        const conversation = (await spaceRequest({}, "POST")).conversation!;
        write(resourceKey(conversation.id), JSON.stringify(openResource(resources, "browser")));
        if (url) try { sessionStorage.setItem("roppo.website." + conversation.id, url); } catch {}
        write(draftKey(conversation.id), runtime.thread.composer.getState().text);
        write(draftKey(null), "");
        await refreshList();
        if (alive.current && location.pathname === "/chat") navigate(conversation.id);
      } catch (error) { fail(error); }
      finally { creating.current = false; }
      return;
    }
    if (url) setPendingWebsite(url);
    if(next&&!panel)panelOpener.current=document.activeElement instanceof HTMLElement?document.activeElement:null;
    setSidebarCards(state => {
      if (!next) return emptySidebarCards;
      return state.revealing ? {...state, revealing:false} : state;
    });
    setResources((state) => next ? openResource(state, next) : { ...state, visible: false });
    if (!next || next === 'activity') setPanelExpanded(false);
  };
  const hash = route.split("#")[1] ?? "tasks";
  const automationRoute=configuring&&hash==='automations';
  const marketRoute=configuring&&(hash==='integrations'||hash.startsWith('integrations/'));
  const marketTools=hash==='integrations'||hash==='integrations/tools';
  const views=useWorkspaceViews();
  const pluginId=configuring&&hash.startsWith('plugin/')?hash.slice(7):null;
  const currentView=views.find(view=>view.id===pluginId);
  const pageNames: Record<string, string> = {
    tasks: L("Workspace", "工作区"),
    "tasks/active": L("Tasks", "任务"),
    "tasks/history": L("Tasks", "任务"),
    attention: L("Needs your attention", "待处理"),
    automations: L("Event automations", "事件自动化"),
    execution: L("Agent team", "Agent 团队"),
    deployments: L("Deployments", "部署"),
    models: L("Model connections", "模型连接"),
    connections: L("Conversation entries", "会话入口"),
    integrations: L("Plugins & tools", "插件与工具"),
    prompts: L("Behavior rules", "行为规则"),
    advanced: L("Settings", "设置"),
    usage: L("Usage guide", "使用指引"),
  };
  const pageTitle =
    currentView?.label[lang] ??
    pageNames[hash] ??
    pageNames[hash.split("/")[0]!] ??
    L("Workspace", "工作区");
  useEffect(() => {
    document.title =
      (configuring ? pageTitle : L("Conversations", "对话")) + " · Roppo";
    setMenu(false);
  }, [route, lang, pageTitle]);
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null),
    [loading, setLoading] = useState(!!id),
    [error, setError] = useState(""),
    [connected, setConnected] = useState(true),
    [sending, setSending] = useState(false),
    [menu, setMenu] = useState(false),
    [selectedAgent, setSelectedAgent] = useState("router"),
    [panelOverlay, setPanelOverlay] = useState(false),
    [narrow, setNarrow] = useState(
      () => matchMedia("(max-width:800px)").matches,
    );
  const alive = useRef(true),
    fetchVersion = useRef(0),
    messagesRef = useRef<Snapshot["messages"]>([]),
    pending = useRef<{
      text: string;
      id: string;
      conversationId: string;
      attachments?:string[];
      quote?:ChatQuote;
    } | null>(savedPending(id)),
    bodyRef = useRef<HTMLDivElement>(null),
    threadRef = useRef<HTMLDivElement>(null),
    panelOpener = useRef<HTMLElement|null>(null),
    teamButton = useRef<HTMLButtonElement>(null),
    menuButton = useRef<HTMLButtonElement>(null);
  const [quote,setQuote]=useState<DraftQuote|null>(()=>savedQuote(id)),[around,setAround]=useState<string>();
  const locateAfterLoad=useRef<string|null>(null),locateRequest=useRef(0),quoteCurrent=useRef(quote);quoteCurrent.current=quote;
  const queuedEnter=useRef<string|null>(null);
  const reactionWrites=useRef(new Map<string,{reactions:string[];promise:Promise<string[]>}>());
  const saveQuote=useCallback((value:DraftQuote|null)=>{quoteCurrent.current=value;setQuote(value);write(quoteKey(id),JSON.stringify(value))},[id]);
  const motion=useChatMotion(threadRef,(id??'new')+':'+selectedAgent+':'+(around??'latest'),!!around,snapshot?.messages.at(-1)?.id);
  useEffect(()=>{const target=locateAfterLoad.current;if(!target||loading)return;const frame=requestAnimationFrame(()=>{if(motion.locate(target))locateAfterLoad.current=null});return()=>cancelAnimationFrame(frame)},[snapshot,loading,motion.locate]);
  useEffect(() => {
    const thread=threadRef.current, transcript=thread?.querySelector<HTMLElement>('.transcript');
    if(!thread||!transcript)return;
    const measure=()=>{
      if(!thread.clientWidth)return;
      thread.closest<HTMLElement>('.chat-main')?.style.setProperty('--chat-lane-width',thread.clientWidth+'px');
      thread.style.setProperty('--chat-scrollbar-gutter',(transcript.offsetWidth-transcript.clientWidth)/2+'px');
    };
    const observer=new ResizeObserver(measure);observer.observe(thread);observer.observe(transcript);measure();
    return ()=>observer.disconnect();
  }, []);
  const closeNavigation = useCallback(() => {
    setMenu(false);
    // The main region must leave inert before its menu button can receive focus.
    requestAnimationFrame(() => menuButton.current?.focus());
  }, []);
  useEffect(() => {
    const node = bodyRef.current;
    if (!node) return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry && entry.contentRect.width > 0)
        setPanelOverlay(
          innerWidth <= 800 ||
            entry.contentRect.width -
              Math.max(360, Math.min(innerWidth * 0.43, 600)) <
              360,
        );
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  const participants = snapshot?.participants ?? [{id:"router",label:boot?.routerLabel??"Router",kind:"router" as const,latestMessage:null},...(boot?.workers??[]).map(w=>({id:w.id,label:w.label,kind:"worker" as const,latestMessage:null}))];
  const uploadConversation=useRef<Promise<string>|null>(null),uploadConversationId=useRef(id),[loadingAttachments,setLoadingAttachments]=useState(!!id),[attachmentBlocked,setAttachmentBlocked]=useState(false);
  const ensureConversation=useCallback(()=>{
    if(id)return Promise.resolve(id);
    if(!uploadConversation.current)uploadConversation.current=spaceRequest({},'POST').then(space=>{const target=space.conversation!.id;uploadConversationId.current=target;write(draftKey(target),read(draftKey(null)));return target}).catch(error=>{uploadConversation.current=null;throw error});
    return uploadConversation.current;
  },[id]);
  const attachmentLanguage=useRef(L);attachmentLanguage.current=L;
  const attachmentAdapter=useMemo(()=>createAttachmentAdapter(ensureConversation,boot?.uploads.maxBytes??25*1024*1024,(en,zh)=>attachmentLanguage.current(en,zh)),[ensureConversation,boot?.uploads.maxBytes]);
  const currentRouter = participants.find(a=>a.id===(snapshot?.routerId??"router"))!;
  const historicalWorker=snapshot?.tasks.find(t=>t.workerId===selectedAgent);
  const selected=participants.find(a=>a.id===selectedAgent)??(historicalWorker?{id:selectedAgent,label:selectedAgent,kind:'worker' as const,latestMessage:null}:currentRouter);
  const readonly = selected.kind === "worker";
  const participantFilter = readonly ? selected.id : undefined;
  const viewKey=JSON.stringify([id,participantFilter,around]),viewRef=useRef(viewKey);viewRef.current=viewKey;
  const ready = snapshot?.readiness ?? boot,
    run = snapshot?.run,
    reply = snapshot?.reply,
    workers = snapshot?.workers ?? boot?.workers ?? [],
    running =
      !!run && ["queued", "running", "cancel_requested"].includes(run.state),
    disabled =
      readonly || !ready?.ready ||
      !!snapshot?.conversation.archived ||
      loading ||
      loadingAttachments ||
      attachmentBlocked ||
      sending;
  const arrivals = p.arrivals;
  if (snapshot && arrivals.current.conversationId !== snapshot.conversation.id) arrivals.current = {
    conversationId:snapshot.conversation.id, since:Date.now(), seen:new Set(snapshot.messages.map(m=>m.id)),
  };
  const reactionOnly = run?.state==='completed' && snapshot?.messages.some(m=>m.runId===run.id && m.role==='user' && m.agentReactions?.length);
  const runMessageId = !readonly ? snapshot?.messages.findLast(m => m.runId === run?.id && m.role === 'assistant' && !m.recipient)?.id ?? '' : '';
  const fail = (e: unknown) => {
    if (alive.current)
      setError(e instanceof ApiError ? e.code : "network_error");
  };
  const refresh = useCallback(async () => {
    if (!id) return;
    const version = ++fetchVersion.current;
    const query=new URLSearchParams();if(participantFilter)query.set('participant',participantFilter);if(around)query.set('around',around);
    const data = await api<Snapshot>("/conversations/" + id + "?"+query);
    if (!alive.current || version !== fetchVersion.current) return;
    const older = messagesRef.current.filter(
      (m) => m.sequence < (data.messages[0]?.sequence ?? Infinity),
    );
    const messages = [...older, ...data.messages].map(m=>reactionWrites.current.has(m.id)?{...m,reactions:reactionWrites.current.get(m.id)!.reactions}:m);
    messagesRef.current = messages;
    setSnapshot({
      ...data,
      messages,
      hasMore: messages[0]?.sequence === 1 ? false : data.hasMore,
    });
    setLoading(false);
    const saved = savedPending(id);
    if (saved && messages.some((m) => m.clientMessageId === saved.id)) {
      write(pendingKey(id), "null");
      if (read(draftKey(id)) === saved.text) write(draftKey(id), "");
    }
  }, [id, participantFilter, around]);
  const refreshCurrent=useRef(refresh);refreshCurrent.current=refresh;
  useEffect(() => {
    alive.current = true;
    messagesRef.current=[];setLoading(!!id);setSnapshot(s=>s?{...s,messages:[]}:s);
    if (!id)
      return () => {
        alive.current = false;
      };
    let source: EventSource | null = null;
    const load = async () => {
      if (!navigator.onLine) {
        setConnected(false);
        return;
      }
      try {
        await refresh();
        if (
          alive.current &&
          source?.readyState === EventSource.OPEN &&
          navigator.onLine
        )
          setConnected(true);
      } catch (e) {
        if (alive.current) {
          setConnected(false);
          setLoading(false);
          if (e instanceof ApiError) fail(e);
        }
      }
    };
    const connect = () => {
      source?.close();
      if (!navigator.onLine) {
        setConnected(false);
        return;
      }
      const connection = new EventSource(
        "/api/chat/conversations/" + id + "/events",
      );
      source = connection;
      connection.onopen = () => {
        if (source === connection) void load();
      };
      connection.addEventListener("change", () => {
        if (source === connection) void load();
      });
      connection.addEventListener("reset", () => {
        connection.close();clearChatDrafts();pending.current=null;window.dispatchEvent(new Event("roppo:chat-space"));
      });
      connection.onerror = () => {
        if (alive.current && source === connection) setConnected(false);
      };
      connection.addEventListener("reconnect", () => {
        if (source === connection) {
          setConnected(false);
          api("/readiness").catch(fail);
        }
      });
    };
    const offline = () => {
      source?.close();
      fetchVersion.current++;
      setConnected(false);
    };
    const online = () => {
      connect();
      void load();
    };
    connect();
    void load();
    window.addEventListener("offline", offline);
    window.addEventListener("online", online);
    const poll = setInterval(() => void load(), 8000);
    return () => {
      alive.current = false;
      fetchVersion.current++;
      source?.close();
      clearInterval(poll);
      window.removeEventListener("offline", offline);
      window.removeEventListener("online", online);
    };
  }, [id, refresh, refreshList]);
  const visibleMessages=(snapshot?.messages ?? []).filter(m=>readonly?m.speaker?.id===selected.id||m.recipient?.id===selected.id:display==='group'||!!m.deliveries?.length||!m.recipient&&(m.role==='user'||!m.speaker||m.speaker.id===selected.id));
  const blocks=groupWorkflow(snapshot,visibleMessages,participantFilter);
  const commandAction=useRef<(()=>boolean)|null>(null);
  const runtime = useExternalStoreRuntime({
    isRunning: !readonly && (!!reply || sending),
    isLoading: loading,
    isSendDisabled: disabled,
    adapters:{attachments:attachmentAdapter},
    activeRunId: reply?.runId,
    messages: visibleMessages,
    convertMessage: (m): ThreadMessageLike => ({
      id: m.id,
      role: m.role,
      createdAt: new Date(m.createdAt),
      metadata: { custom: {
        linkFiles: m.role === 'assistant' ? snapshot?.deliveries.filter(file =>
          file.createdAt <= m.createdAt && (m.ticketId ? file.ticketId === m.ticketId : file.runId === m.runId)
        ) : undefined,
        speaker: m.speaker, recipient: m.recipient, attachments: m.attachments, deliveries: m.deliveries,
        ticketId: m.ticketId, decision:m.decision, fileReview:m.fileReview && {...m.fileReview,name:m.text}, quote: m.quote, reactions: m.reactions, agentReactions: m.agentReactions,
      } },
      content: [{ type: "text", text: m.text }],
      ...(m.role === "assistant"
        ? {
            status:
              m.status === "streaming"
                ? { type: "running" }
                : m.status === "interrupted" || m.status === "failed"
                  ? {
                      type: "incomplete",
                      reason:
                        m.status === "interrupted" ? "cancelled" : "error",
                    }
                  : { type: "complete", reason: "stop" },
          }
        : {}),
    }),
    onNew: async (message) => {
      const text = message.content
        .filter((c) => c.type === "text")
        .map((c) => c.text)
        .join("\n")
        .trim();
      const attachments=message.attachments?.map(a=>a.id)??[],sentQuote=quoteReference(quote);
      if ((!text&&!attachments.length) || sending || readonly) return;
      setSending(true);
      setError("");
      let target = id;
      let submittedId:string|undefined,accepted=false;
      try {
        if (!target) {
          target = await ensureConversation();
        }
        if (
          !pending.current ||
          pending.current.text !== text ||
          JSON.stringify(pending.current.quote??null)!==JSON.stringify(sentQuote??null) ||
          JSON.stringify(pending.current.attachments??[])!==JSON.stringify(attachments) ||
          pending.current.conversationId !== target
        )
          pending.current = {
            text,
            id: crypto.randomUUID(),
            conversationId: target,
            attachments,
            quote:sentQuote,
          };
        write(pendingKey(target), JSON.stringify(pending.current));
        submittedId=pending.current.id;
        write(draftKey(target), text);
        if (!id && alive.current) {
          const url = new URL(location.href);
          url.search = "";
          history.replaceState(null, "", url);
        }
        if (arrivals.current.conversationId !== target) arrivals.current = {conversationId:target,since:Date.now(),seen:new Set()};
        await api("/conversations/" + target + "/messages", {
          text,
          attachments,
          quote:sentQuote,
          clientMessageId: pending.current.id,
          locale: navigator.language || lang,
        });
        accepted=true;
        if(JSON.stringify(quoteReference(quoteCurrent.current)??null)===JSON.stringify(sentQuote??null))saveQuote(null);
        motion.latest();
        if(around)setAround(undefined);
        pending.current = null;
        write(pendingKey(target), "null");
        const nextDraft=runtime.thread.composer.getState().text;
        write(draftKey(id),nextDraft);
        write(draftKey(target),nextDraft);
        if(target!==id)await refreshList();
        if (alive.current) {
          if (target !== id) navigate(target);
          else if(!around)await refreshCurrent.current();
        }
      } catch (e) {
        // Admission and refreshing the view are separate: an acknowledged send is no longer a draft.
        if(accepted){if(alive.current)setError('sent_refresh_failed');return;}
        if(submittedId&&pending.current?.id!==submittedId)return;
        fail(e);
        write(draftKey(target ?? id), text);
        if (alive.current) {
          runtime.thread.composer.setText(text);
          for(const attachment of message.attachments??[])await runtime.thread.composer.addAttachment(attachment);
          if (target && target !== id) navigate(target);
        }
      } finally {
        if (alive.current) setSending(false);
      }
    },
    hasEarlier: snapshot?.hasMore ?? false,
    onLoadEarlier: async () => {
      if (!id || !snapshot?.messages.length) return;
      const version=viewRef.current;
      const data = await api<Snapshot>(
        "/conversations/" +
          id +
          "/messages?before=" +
          snapshot.messages[0]!.sequence + (participantFilter ? "&participant="+encodeURIComponent(participantFilter) : ""),
      );
      if (!alive.current||version!==viewRef.current) return;
      const ids = new Set(messagesRef.current.map((m) => m.id));
      const messages = [
        ...data.messages.filter((m) => !ids.has(m.id)),
        ...messagesRef.current,
      ];
      messagesRef.current = messages;
      setSnapshot((s) => (s ? { ...s, messages, hasMore: data.hasMore } : s));
    },
  });
  useEffect(()=>{
    if(disabled||queuedEnter.current===null)return;
    const requested=queuedEnter.current;queuedEnter.current=null;
    if(runtime.thread.composer.getState().text===requested)runtime.thread.composer.send();
  },[disabled,runtime]);
  useEffect(()=>{
    if(!id)return;
    let active=true;
    api<{attachments:ChatAttachment[]}>("/conversations/"+id+"/attachments").then(async result=>{
      for(const file of result.attachments)if(active&&!runtime.thread.composer.getState().attachments.some(a=>a.id===file.id))await runtime.thread.composer.addAttachment(attachmentParts(file));
    }).catch(fail).finally(()=>{if(active)setLoadingAttachments(false)});
    return()=>{active=false};
  },[runtime,id]);
  useEffect(() => {
    runtime.thread.composer.setText(
      read(draftKey(id)) || savedPending(id)?.text || "",
    );
    return runtime.thread.composer.subscribe(() => {
      const composer=runtime.thread.composer.getState(),text=composer.text;write(draftKey(id),text);
      setAttachmentBlocked(composer.attachments.some(a=>a.status.type==='running'||a.status.type==='incomplete'));
      if(uploadConversationId.current&&uploadConversationId.current!==id)write(draftKey(uploadConversationId.current),text);
    });
  }, [runtime, id]);
  useEffect(() => {
    const media = matchMedia("(max-width:800px)");
    const change = () => {
      setNarrow(media.matches);
      if (!media.matches) setMenu(false);
    };
    media.addEventListener("change", change);
    return () => media.removeEventListener("change", change);
  }, []);
  useEffect(() => {
    const saved = pending.current;
    if (
      saved &&
      snapshot?.messages.some((m) => m.clientMessageId === saved.id)
    ) {
      pending.current = null;
      if(JSON.stringify(quoteReference(quote)??null)===JSON.stringify(saved.quote??null))saveQuote(null);
      for(const [index,file] of [...runtime.thread.composer.getState().attachments.entries()].reverse())
        if(saved.attachments?.includes(file.id))void runtime.thread.composer.getAttachmentByIndex(index).remove();
      if (runtime.thread.composer.getState().text === saved.text)
        runtime.thread.composer.setText("");
    }
  }, [snapshot, runtime]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !e.isComposing && !e.defaultPrevented && !document.querySelector("dialog[open]")) {
        if (menu) {
          closeNavigation();
        } else if (sidebarCards.revealing) {
          dismissCard(sidebarCards.items[0]!);
        } else if (panel) {
          closePanel();
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [menu, panel, resource, sidebarCards, panelOverlay, closeNavigation]);
  useEffect(() => {
    if (narrow && menu)
      document
        .querySelector<HTMLAnchorElement>('.function-link[aria-current="page"]')
        ?.focus();
  }, [narrow, menu]);
  const current = snapshot?.conversation;
  const selectAgent=(agentId:string)=>{locateRequest.current++;locateAfterLoad.current=null;setAround(undefined);setSelectedAgent(agentId);setSidebarCards(emptySidebarCards)};
  function revealCard(card: ChatCommand) {
    if (!panel) {
      panelOpener.current = threadRef.current?.querySelector<HTMLElement>('.composer-input') ?? null;
      setTeamTab('activity');
      setResources(state => openResource(state, 'activity'));
    }
    setSidebarCards(state => ({items:[card, ...state.items.filter(item => item !== card)], revealing:true}));
    requestAnimationFrame(() => bodyRef.current?.querySelector('.team-tab-content')?.scrollTo({top:0, behavior:'instant'}));
  }
  function dismissCard(card: ChatCommand) {
    const items = sidebarCards.items.filter(item => item !== card);
    const revealing = sidebarCards.revealing && items.length > 0;
    setSidebarCards({items, revealing});
    requestAnimationFrame(() => {
      const target = panelOverlay
        ? bodyRef.current?.querySelector<HTMLElement>('#session-panel [role=tab][aria-selected=true]:not([tabindex="-1"])')
        : threadRef.current?.querySelector<HTMLElement>('.composer-input');
      target?.focus({preventScroll:true});
    });
  }
  function closePanel() {
    void choosePanel(null);
    requestAnimationFrame(() => (panelOpener.current?.isConnected ? panelOpener.current : teamButton.current)?.focus({preventScroll: true}));
  }
  const readAgent=(agentId:string)=>{selectAgent(agentId);void choosePanel(null);requestAnimationFrame(()=>threadRef.current?.querySelector<HTMLElement>('.worker-readonly button,.composer-input')?.focus({preventScroll:true}))};
  const quoteMessage=(value:DraftQuote)=>{
    saveQuote(value);selectAgent(currentRouter.id);
    requestAnimationFrame(()=>threadRef.current?.querySelector<HTMLTextAreaElement>('.composer-input')?.focus({preventScroll:true}));
  };
  const locateMessage=async(messageId:string)=>{
    const version=++locateRequest.current;
    if(motion.locate(messageId))return;
    try{
      const data=await api<Snapshot>('/conversations/'+id+'?around='+encodeURIComponent(messageId));
      if(!alive.current||version!==locateRequest.current)return;
      const message=data.messages.find(m=>m.id===messageId)!;
      const participant=message.speaker?.kind==='worker'?message.speaker.id:message.recipient?.kind==='worker'?message.recipient.id:currentRouter.id;
      locateAfterLoad.current=messageId;
      if(display==='agents'||readonly)setSelectedAgent(participant);
      setAround(messageId);
    }catch(e){fail(e)}
  };
  const reactMessage=(messageId:string,emoji:string)=>{
    const previous=reactionWrites.current.get(messageId),message=messagesRef.current.find(m=>m.id===messageId);if(!message||!id)return;
    const reactions=new Set(previous?.reactions??message.reactions??[]),active=!reactions.has(emoji);
    if(active)reactions.add(emoji);else reactions.delete(emoji);
    const update={reactions:[...reactions],promise:Promise.resolve(message.reactions??[])};
    reactionWrites.current.set(messageId,update);
    messagesRef.current=messagesRef.current.map(m=>m.id===messageId?{...m,reactions:update.reactions}:m);
    setSnapshot(s=>s?{...s,messages:messagesRef.current}:s);
    update.promise=(previous?.promise??Promise.resolve(message.reactions??[])).then(async confirmed=>{
      try{confirmed=(await api<{reactions:string[]}>('/conversations/'+id+'/reactions',{messageId,emoji,active})).reactions}catch{if(alive.current)setError('reaction_failed')}
      if(reactionWrites.current.get(messageId)===update){
        reactionWrites.current.delete(messageId);
        messagesRef.current=messagesRef.current.map(m=>m.id===messageId?{...m,reactions:confirmed}:m);
        if(alive.current){setSnapshot(s=>s?{...s,messages:messagesRef.current}:s);await refreshCurrent.current().catch(fail)}
      }
      return confirmed;
    });
  };
  const latestMessages=()=>{locateRequest.current++;locateAfterLoad.current=null;if(around)setAround(undefined);motion.latest()};
  return (
    <Context.Provider
      value={{
        lang,
        L,
        workers,
        routerLabel:currentRouter.label,
        openFile:setFile,openWorker:readAgent,workerView:readonly,
        run: run ?? null,
        runMessageId,
        arrivals:arrivals.current,
      }}
    >
      <WorkflowProvider value={{L,blocks,readonly,tools:calls=><ToolCalls calls={calls} workers={workers}/>,
        decide:async(messageId,answer)=>{try{await api('/conversations/'+id+'/decisions',{messageId,answer,locale:lang})}finally{await refresh()}},
        readDraft:(messageId)=>api('/conversations/'+id+'/file-reviews?message='+encodeURIComponent(messageId)),
        reviewFile:async(messageId,state)=>{try{await api('/conversations/'+id+'/file-reviews',{messageId,state})}finally{await refresh()}},
        authorize:async(request,value)=>{try{await api('/conversations/'+id+'/approvals',{id:request,value})}finally{await refresh()}}
      }}><AssistantRuntimeProvider runtime={runtime}>
        <InteractionProvider L={L} messages={snapshot?.messages??[]} reply={quoteMessage} react={reactMessage} locate={messageId=>void locateMessage(messageId)}>
        <div
          className={
            "chat-shell" +
            (menu ? " menu-open" : "") +
            (panel ? " team-open" : "") +
            (navExpanded ? " functions-expanded" : "") +
            (configuring ? " management-mode" : "") +
            (display === "group" ? " conversation-list-hidden" : "")
          }
        >
          <a className="skip-link" href="#conversation">
            {configuring
              ? L("Skip to content", "跳转到内容")
              : L("Skip to conversation", "跳转到对话")}
          </a>
          <FeatureNavigation
            L={L}
            configuring={configuring}
            hash={hash}
            expanded={navExpanded}
            onExpanded={() => setNavExpanded(!navExpanded)}
            mobile={narrow}
            menuOpen={menu}
            closeMenu={closeNavigation}
            openWorkspaces={() => {if(automationRoute||pluginId||marketRoute&&!marketTools){history.pushState(null,"","/configure#tasks");window.dispatchEvent(new Event('roppo:navigation'))}setPickerRequest((value) => value + 1)}}
            user={boot?.user}
            views={views.map(view=>({id:view.id,label:view.label[lang]}))}
          />
          {display === "agents" && !configuring ? <aside className="conversation-sidebar" id="agent-list" inert={(narrow && !menu) || (narrow && navExpanded)} aria-label={L("Agents", "Agents 列表")}>
            <header className="conversation-heading"><h2>{L("Agents", "Agents 列表")}</h2></header>
            <div className="agent-list">{participants.map(agent=>{
              const latest=agent.latestMessage,prefix=latest?.role==='user'?L('You: ','你：'):latest?.speaker&&latest.speaker!==agent.label?latest.speaker+': ':'';
              const preview=latest?prefix+latest.text.replace(/\s+/g,' ').trim():L('No messages yet','暂无消息');
              return <div key={agent.id} className="agent-contact-row"><button className="agent-contact" aria-pressed={selected?.id===agent.id} onClick={()=>{selectAgent(agent.id);if(narrow)closeNavigation()}}>
                <AgentAvatar id={agent.id} kind={agent.kind} size={36} /><span><span className="agent-name"><span className="agent-label">{agent.label}</span><span className="agent-role">{agent.kind === "worker" ? "Worker" : "Router"}</span></span><small title={preview}>{preview}</small></span>
              </button><a className="agent-manage" href={"/configure#execution/configuration/"+encodeURIComponent(agent.kind==='router'?'router':agent.id)} aria-label={L('Manage ','管理 ')+agent.label} title={L('Manage ','管理 ')+agent.label}><SlidersHorizontal size={15}/></a></div>
            })}</div>
          </aside> : null}
          {menu ? (
            <button
              className="nav-scrim"
              aria-label={L("Close navigation", "关闭导航")}
              onClick={closeNavigation}
            />
          ) : null}
          <main
            className="chat-main"
            id="conversation"
            tabIndex={-1}
            inert={narrow && menu}
          >
            <header className="chat-header" data-chat={!configuring||undefined}>
              <button
                className="icon-button mobile-menu"
                ref={menuButton}
                onClick={() => setMenu(true)}
                aria-label={L("Open navigation", "打开导航")}
                aria-expanded={menu}
                aria-controls={display === "agents" ? "function-navigation agent-list" : "function-navigation"}
              >
                <Menu size={20} />
              </button>
              <div className="chat-breadcrumb">
                <span>
                  {configuring
                    ? L("Current workspace", "当前工作区")
                    : L("Conversations", "对话")}
                </span>
                <span className="slash">/</span>
                <strong>
                  {configuring
                    ? pageTitle
                    : display === "agents" ? selected?.label : L("Team chat", "团队群聊")}
                </strong>
              </div>
              {!configuring ? <ChatCompanion key={(id??"new")+":"+(readonly?selected.id:"group")} status={companionStatus(snapshot,L,{participantId:readonly?selected.id:undefined,connected,sending,loading})} L={L} onOpen={()=>{setTeamTab("activity");void choosePanel("activity")}}/> : null}
              <div className="header-actions">
                {!configuring ? (
                  <button
                    ref={teamButton}
                    className={"icon-button" + (panel ? " selected" : "")}
                    onClick={() => void choosePanel(panel ? null : lastView)}
                    aria-label={L("Session panel", "会话面板")}
                    title={L("Session panel", "会话面板")}
                    aria-expanded={!!panel}
                    aria-controls="session-panel"
                  >
                    <PanelRight size={19} />
                  </button>
                ) : null}
                <IconButton
                  label={
                    dark
                      ? L("Switch to light mode", "切换为浅色模式")
                      : L("Switch to dark mode", "切换为深色模式")
                  }
                  onClick={() => setDark(!dark)}
                >
                  {dark ? <Sun size={19} /> : <Moon size={19} />}
                </IconButton>
                <button
                  className="language-button"
                  onClick={() => setLang(lang === "en" ? "zh-CN" : "en")}
                  aria-label={L("Switch to Chinese", "切换为英文")}
                >
                  {lang === "en" ? "中文" : "EN"}
                </button>
              </div>
            </header>
            <SwitchView scope="page"><div className="workspace-page-stage" data-route={route}>
            {marketRoute?<Suspense fallback={<div className="workspace-view-placeholder" role="status">{L("Loading plugins…","正在加载插件…")}</div>}><PluginMarketplace route={hash} language={lang}/></Suspense>:null}
            {automationRoute?<Suspense fallback={<div className="workspace-view-placeholder" role="status">{L("Loading automations…","正在加载自动化…")}</div>}><AutomationWorkspace language={lang}/></Suspense>:null}
            <Configuration
              visible={configuring&&!automationRoute&&!pluginId&&(!marketRoute||marketTools)}
              route={route}
              language={lang}
              pickerRequest={pickerRequest}
            />
            {pluginId?<WorkspaceView key={pluginId} id={pluginId} view={currentView} dark={dark} language={lang}/>:null}
            <div
              ref={bodyRef}
              className={
                "conversation-body" + (panelOverlay ? " panel-overlay" : "")
              }
              hidden={configuring}
            >
              <ThreadPrimitive.Root
                ref={threadRef}
                className="thread"
                inert={(!overview && panelExpanded) || (panelOverlay && !!panel)}
              >
                <ThreadPrimitive.Viewport className="transcript" autoScroll={false} scrollToBottomOnRunStart={false} scrollToBottomOnInitialize={false} scrollToBottomOnThreadSwitch={false}>
                  <div className="transcript-inner">
                    <ThreadPrimitive.LoadEarlier className="load-earlier">
                      {L("Load earlier messages", "加载更早的消息")}
                    </ThreadPrimitive.LoadEarlier>
                    {loading ? (
                      <div className="loading" role="status">
                        <LoaderCircle size={22} className="spin" />
                        {L("Loading conversation", "正在加载会话")}
                      </div>
                    ) : null}
                    <ThreadPrimitive.Empty>
                      <div className="empty-state">
                        <AgentAvatar id={selected.id} kind={selected.kind} size={72} />
                        <h1>
                          {readonly ? L("No collaboration messages yet", "暂无协作消息") : L("What shall we work on?", "今天想完成什么？")}
                        </h1>
                      </div>
                    </ThreadPrimitive.Empty>
                    <ThreadPrimitive.Messages
                      components={{ UserMessage, AssistantMessage }}
                    />
                    <WorkflowCards anchor="pending"/>
                    {(snapshot?.browsers??[]).filter(b=>(!b.ended||b.runId===run?.id)&&(!readonly||b.workerId===selected.id)).map(b=><div className="chat-browser" key={b.id}>
                      <Globe size={20}/><div><strong>{b.title||L('Browser','浏览器')}</strong><span>{b.handoffReason|| (b.ended?L('Task ended','任务已结束'):(b.control==='worker'||b.control==='router')?L('Agent is browsing','Agent 正在浏览'):L('Waiting for you','等待你操作'))}</span></div>
                      <button onClick={()=>{setBrowserRequest({id:b.id,takeover:!b.ended&&b.control==='paused',key:Date.now()});void choosePanel('browser')}}>{!b.ended&&b.control==='paused'?<Hand size={15}/>:null}{!b.ended&&b.control==='paused'?L('Take control','接管'):L('View page','查看网页')}</button>
                    </div>)}
                    {run&&!readonly&&!runMessageId&&!reactionOnly?<div className="run-activity" aria-live="polite">
                      <div className={"run-status "+run.state}><StatusIcon state={run.state}/><span>{runLabel(run.state,L)}</span></div>
                    </div>:null}
                  </div>
                </ThreadPrimitive.Viewport>
                <div className="composer-area">
                  <button type="button" className="scroll-bottom" data-visible={!motion.atBottom||!!around} tabIndex={!motion.atBottom||around?0:-1} aria-hidden={motion.atBottom&&!around} aria-label={L("Scroll to latest", "回到最新消息")} onClick={latestMessages}>
                    <ArrowDown size={16}/>{motion.unread?<span>{L('New messages','有新消息')}</span>:around?<span>{L('Back to latest','回到最新')}</span>:null}
                  </button>
                  {error ? (
                    <ErrorNotice code={error} clear={() => setError("")} />
                  ) : null}
                  {!connected ? (
                    <div className="connection-state" role="status">
                      <RefreshCw size={14} />
                      {L(
                        "Reconnecting… Your work continues.",
                        "正在重连，任务仍在继续。",
                      )}
                    </div>
                  ) : null}
                  <Readiness ready={ready} />
                  {readonly ? <div className="composer worker-readonly"><textarea disabled rows={1} aria-label={L("Please talk to Router", "请与 Router 对话")} placeholder={L("Please talk to Router", "请与 Router 对话")}/><button onClick={()=>selectAgent(currentRouter.id)}>{L("Go to Router", "前往 Router")}</button></div> : <ComposerPrimitive.AttachmentDropzone asChild disabled={sending||loadingAttachments||!ready?.ready}><ComposerPrimitive.Root className="composer">
                    <QuotePreview quote={quote} L={L} onClear={()=>saveQuote(null)}/>
                    <div className="composer-attachments"><ComposerPrimitive.Attachments components={{Attachment:ComposerAttachment}}/></div>
                    <CommandInput visible={!configuring} L={L} onCommand={revealCard} consume={commandAction}
                      className="composer-input"
                      placeholder={L("Message " + currentRouter.label + "…", "向 " + currentRouter.label + " 发送消息…")}
                      aria-label={L("Message " + currentRouter.label, "向 " + currentRouter.label + " 发送消息")}
                      rows={1}
                      maxLength={100000}
                      submitMode="none"
                      onKeyDown={event=>{
                        if(event.key!=="Enter"||event.shiftKey||event.nativeEvent.isComposing||event.keyCode===229)return;
                        event.preventDefault();
                        if((sending||loading||loadingAttachments)&&event.currentTarget.value.trim()){
                          queuedEnter.current=event.currentTarget.value;return;
                        }
                        runtime.thread.composer.send();
                      }}
                    />
                    <div className="composer-toolbar">
                      <ComposerPrimitive.AddAttachment className="icon-button attach-button" disabled={sending||loadingAttachments||!ready?.ready} aria-label={L('Attach files','上传文件')} title={L('Attach files','上传文件')}><Paperclip size={18}/></ComposerPrimitive.AddAttachment>
                      <RouterModelControl visible={!configuring} label={currentRouter.label} model={current?.model || ready?.model} busy={running||sending} L={L} onSaved={async()=>{await p.refreshReady();await refresh()}}/>
                      {workers.length ? (
                        <button
                          className="team-chip"
                          type="button"
                          aria-expanded={panel === "activity"}
                          aria-label={L("View Workers and team settings", "查看 Worker 和团队设置")}
                          onClick={()=>{setTeamTab("agents");void choosePanel("activity")}}
                        >
                          <Users size={15} />
                          <span>
                            {workers.length} {L(workers.length===1?"worker":"workers", "个 Worker")}
                          </span>
                        </button>
                      ) : null}
                      <div className="send-actions">
                        <SendMessage sending={sending} consume={()=>commandAction.current?.()??false}/>
                      </div>
                    </div>
                  </ComposerPrimitive.Root></ComposerPrimitive.AttachmentDropzone>}
                </div>
              </ThreadPrimitive.Root>
              {panel && <aside id="session-panel" aria-label={L('Session panel', '会话面板')}
                className={'session-panel '+(overview ? 'chat-inspector team-drawer' : 'resource-workspace'+(panelExpanded?' expanded':''))}>
                {overview && <TeamOverview snapshot={snapshot} participants={participants} routerLabel={currentRouter.label} lang={lang} L={L}
                  tab={sidebarCards.revealing ? 'activity' : teamTab} focusOnOpen={!sidebarCards.revealing}
                  setTab={tab => {
                    if (sidebarCards.revealing && tab !== 'activity') void choosePanel('activity');
                    setTeamTab(tab);
                  }}
                  close={closePanel} select={readAgent} openFile={setFile} resource={kind=>void choosePanel(kind)}
                  cards={!configuring && !readonly && sidebarCards.items.length > 0 && sidebarCards.items.map(card =>
                    card === 'context' && <ContextCard key={JSON.stringify([card, id, current?.backend, current?.model])}
                      conversationId={id} load={loadContext} L={L} focusOnReveal={panelOverlay && sidebarCards.revealing}
                      onClose={()=>dismissCard(card)} />
                  )}
                  changeSchedule={async plan=>{try{await api('/conversations/'+id+'/schedules',{id:plan.id,active:!plan.active,operationId:crypto.randomUUID(),expectedRevision:plan.revision},'PATCH')}finally{await refresh()}}}
                />}
                <ResourceWorkspace
                  hidden={overview}
                  state={resources}
                  browser={id && !configuring ? {conversationId:id, requestedSession:browserRequest,
                    requestedUrl:pendingWebsite, onUrlConsumed:consumeWebsite} : undefined}
                  onChange={setResources}
                  onOpen={(kind, url) => {
                    if (kind === 'activity') setTeamTab('activity');
                    void choosePanel(kind, url);
                  }}
                  expanded={panelExpanded}
                  onExpand={() => setPanelExpanded(!panelExpanded)}
                  onClose={closePanel}
                  L={L}
                >
                  {activeTool === "files" ? (
                    <FilesPanel conversationId={id} L={L} />
                  ) : null}
                </ResourceWorkspace>
              </aside>}
            </div>
            </div></SwitchView>
          </main>
        </div>
        {file?<FileViewer key={file.id} file={file} L={L} close={()=>setFile(null)}/>:null}
        </InteractionProvider>
      </AssistantRuntimeProvider></WorkflowProvider>
    </Context.Provider>
  );
}
createRoot(document.getElementById("root")!).render(<App />);
