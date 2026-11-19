import {chatUploadLimits} from '../../src/execution-limits.ts'
import {teamName} from './agent-avatar.tsx';
import {chatLocation} from './pending-links.ts';
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
  useAuiState,
  useMessagePartText,
  type ThreadMessageLike,
} from "@assistant-ui/react";

import {
  ArrowDown,
  ListChecks,
  UsersRound,
  FileText,
  PanelRight,
  Inbox,
  Menu,
  Settings,
  X,
  ChevronRight,
  LoaderCircle,
  Square,
  AlertCircle,
  RefreshCw,
  Globe,
  Hand,
} from "lucide-react";
import type { ChatSessions } from "../../src/chat.ts";
import {DeliveryFileCard,DeliveryFileViewer} from "../ui/delivery-files.tsx";
import {deliveryFile} from "./delivery-links.ts";
import {TeamOverview,type TeamTab} from './team-view.tsx';
import type {TaskExecutionDetail} from '../../src/chat-task-detail.ts';
import type {ChatDelivery} from '../../src/chat-deliveries.ts';
import {WorkflowProvider,WorkflowCards,PendingNotice,PendingTray,groupWorkflow} from './workflow-cards.tsx';
import {ComposerControls} from './composer-actions.tsx';
import {ContextCard, useCurrentContext} from './context-card.tsx';
import {ToolTrace} from './tool-trace.tsx';
import '../ui/theme.css';
import '../ui/components.css';
import '../ui/agent-components.css';
import '../ui/transitions.css';
import './workflow.css';
import { ResourceWorkspace } from "./resource-workspace.tsx";
import { initialResources, openResource, resourceKey, type ResourceKind } from "./resource-state.ts";
import { ChatMemberPicker, StudioRail, General } from "./studio-navigation.tsx";
import { SwitchView, switchView } from "../ui";
import { SidebarSeparator } from "./sidebar-separator.tsx";
import { usePanelPresence } from './panel-presence.ts';
import {lazy,Suspense} from "react";
const PluginMarketplace=lazy(()=>import("./plugin-marketplace.tsx").then(m=>({default:m.PluginMarketplace})));
const ConnectorsWorkspace=lazy(()=>import("./connectors.tsx").then(m=>({default:m.ConnectorsWorkspace})));
const AutomationWorkspace=lazy(()=>import("./automations.tsx").then(m=>({default:m.AutomationWorkspace})));
const UsageStatisticsPage = lazy(() => import("./usage-statistics.tsx").then(module => ({default: module.UsageStatisticsPage})));
const TaskDetail=lazy(()=>import("./task-detail.tsx").then(m=>({default:m.TaskDetail})));
import {spaceRequest,clearChatDrafts,type ChatSpace} from './chat-settings.tsx';
import { Configuration } from "./configuration.tsx";
import {WorkspaceView,useWorkspaceViews} from './workspace-view.tsx';
import { FilesPanel } from "./files.tsx";
import { AgentAvatar } from "./agent-avatar.tsx";

import {useHandoffPlayer,type HandoffCursor} from './use-handoff.ts';
import {ChatCompanion} from "./companion.tsx";
import {companionStatus,pendingWaitLabel} from "./companion-state.ts";
import {InteractionProvider,MessageActions,Reactions,QuotePreview,QuotedMessage,type DraftQuote} from './message-interactions.tsx';
import {useChatMotion} from './chat-motion.ts';
import type {ChatQuote,ChatQuoteView} from '../../src/chat-interactions.ts';
import {attachmentError,attachmentParts,createAttachmentAdapter,DraftAttachment,MessageAttachments} from './attachments.tsx';
import type {ChatAttachment} from '../../src/chat-attachments.ts';
import {carryInitialDraft,draftKey,forgetPending,read,savedPending,useMessageSend,write,type OutgoingMessage} from './message-send.ts';
const RichMarkdown=lazy(()=>import("./markdown.tsx"));
import "../../src/ui/theme.css";
import "../../src/ui/typography.css";
import "./style.css";
import "./rich-content.css";
import "./navigation.css";
import "./chat-layout.css";
import "./team-view.css";
import "./task-detail.css";
import "./sidebar-resize.css";
import "./studio.css";
import "./settings-design.css";
import "./floating-chat.css";
import { WorkspaceSettings, workspaceGroups } from "./workspace-settings.tsx";

type Snapshot = ReturnType<ChatSessions["view"]>;
type Conversation = Snapshot["conversation"];
type Ready = Snapshot["readiness"] & { user?: { displayName: string } };
type Worker = Snapshot["workers"][number];
type Language = "en" | "zh-CN";
type Arrivals = {conversationId:string;since:number;seen:Set<string>};
const quoteKey=(id:string|null)=>"roppo.chat.draft.quote."+(id??"new");
function savedQuote(id:string|null):DraftQuote|null {
  try{return JSON.parse(read(quoteKey(id),'null'))}catch{return null}
}
const quoteReference=(quote:DraftQuote|null):ChatQuote|undefined=>quote?{messageId:quote.messageId,...(quote.excerpt?{excerpt:quote.excerpt}:{})}:undefined;
class ApiError extends Error {
  constructor(readonly code: string, readonly status?:number) {
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
  if (!response.ok) throw new ApiError(result.code ?? "request_failed",response.status);
  return result;
}
const loadContext=(id:string,signal:AbortSignal)=>api<ReturnType<ChatSessions["contextUsage"]>>("/conversations/"+id+"/context",undefined,"GET",signal);
const Context = createContext({
  lang: "en" as Language,
  L: (en: string, zh: string) => en,
  workers: [] as Worker[],
  routerLabel: 'Roppo',
  openFile: (_file:ChatDelivery)=>{},
  openAgent: (_id:string)=>{},
  run: null as Snapshot['run'],
  runMessageId: '',
  waitingLabel: '',
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
    code==='sent_refresh_failed'?L('Message sent. Syncing replies…','消息已发送，正在同步回复…'):
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
function runLabel(state: string, L: (en: string, zh: string) => string, waitingLabel:string) {
  return ({waiting:waitingLabel||L('Waiting for your input','等待你的补充'),cancel_requested:L('Stopping…','正在停止…'),cancelled:L('Stopped','已停止'),failed:L('Couldn’t finish. Send a follow-up to retry.','未能完成，可补充消息后重试。')} as Record<string,string>)[state];
}
function UserMessage() {
  const { L } = useUI(),
    id = useAuiState((s) => s.message.id),
    attachments = useAuiState((s) => s.message.metadata.custom?.attachments) as ChatAttachment[]|undefined,
    hasText = useAuiState((s) => s.message.content.some(c=>c.type==='text'&&!!c.text)),
    createdAt = useAuiState((s) => s.message.createdAt),
    arrival = useArrival(id, createdAt.getTime());
  const inline=useAuiState(s=>s.message.metadata.custom?.inlineAnswer===true);
  if(inline)return <WorkflowCards anchor={id}/>;
  return (
    <>
      <MessagePrimitive.Root className="message user-message" data-arrival={arrival}>
        <UserQuote/>
        <div className="message-line" tabIndex={-1}>
          <div className="message-surface">
            <MessageAttachments files={attachments??[]} L={L}/>
            {hasText && <div className="user-bubble" data-message-body><MessagePrimitive.Parts components={{Text:Markdown}}/></div>}
          </div>
          <MessageActions id={id}/>
        </div>
        <Reactions id={id}/>
        <Timestamp at={createdAt}/>
      </MessagePrimitive.Root>
      <WorkflowCards anchor={id}/>
    </>
  );
}
function OutgoingBubble({message,retry,edit,draftQuoted}:{message:OutgoingMessage;retry:()=>void;edit:()=>void;draftQuoted:boolean}){
  const {L}=useUI();
  const canEdit=useAuiState(s=>!s.composer.text.trim()&&!s.composer.attachments.length);
  const {stage,input,files,quote,createdAt}=message;
  const waiting=stage==='slow'||stage==='unconfirmed';
  const status=stage==='sending'?L('Sending…','发送中…'):
    waiting?L('Delivery not confirmed yet.','还未确认送达。'):
    stage==='rejected'?L('Message not sent. Your draft is saved.','发送失败，草稿已保留。'):'';
  return <div className="message user-message" data-outgoing={stage}>
    <QuotedMessage quote={quote??undefined}/>
    <div className="message-line"><div className="message-surface">
      {!!files.length&&<div className="message-attachments">{files.map(file=><span key={file.id} className="chat-attachment"><FileText size={22}/><span className="attachment-info"><strong>{file.name}</strong></span></span>)}</div>}
      {input.text&&<div className="user-bubble">{input.text}</div>}
    </div></div>
    {status&&<div className="chat-send-status"><span role="status">{status}</span>
      {waiting&&<button type="button" className="text-button" onClick={retry}>{L('Retry send','重试')}</button>}
      {stage==='rejected'&&<button type="button" className="text-button" disabled={!canEdit||draftQuoted} onClick={edit}>{L('Edit message','编辑消息')}</button>}
    </div>}
    <Timestamp at={createdAt}/>
  </div>;
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
  const { L, run, runMessageId, waitingLabel, routerLabel, openFile,openAgent } = useUI(),
    deliveries=useAuiState(s=>s.message.metadata.custom?.deliveries) as ChatDelivery[]|undefined,
    decision=useAuiState(s=>s.message.metadata.custom?.decision) as Snapshot["messages"][number]["decision"],
    fileReview=useAuiState(s=>s.message.metadata.custom?.fileReview) as (NonNullable<Snapshot["messages"][number]["fileReview"]> & {name:string})|undefined,
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
    streaming = status?.type === "running",
    footerStatus = run && runMessageId === id ? runLabel(run.state,L,waitingLabel??'') : undefined;
  const continuedReview=useAuiState(s=>!!s.message.metadata.custom?.continuedReview);
  if (streaming && !hasText) return <WorkflowCards anchor={id}/>;
  let body: ReactNode;
  if (deliveries?.length) {
    body = <>{fileReview && <PendingNotice id={id} kind="review" notice={fileReview.notice} subject={fileReview.name}/>} {deliveries.map(file => <DeliveryFileCard key={file.id} L={L} file={deliveryFile(file)} onOpen={()=>openFile(file)}/>)}</>;
  } else if (fileReview) {
    body = <PendingNotice id={id} kind="review" notice={fileReview.notice} subject={fileReview.name} status={
      fileReview.state==='denied'?L('Declined','已拒绝'):fileReview.state==='superseded'?L('Replaced','已替换'):undefined}/>;
  } else if (decision) {
    body = <PendingNotice id={id} kind="answer" notice={decision.pendingNotice} subject={decision.question}
      status={decision.answer || (decision.closed?L('Cancelled','已取消'):undefined)}/>;
  } else {
    body = <div data-message-body><MessagePrimitive.Parts components={{ Text: Markdown }}/></div>;
  }
  return (
    <><MessagePrimitive.Root
      className="message assistant-message"
      data-arrival={arrival}
      data-streaming={streaming ? "true" : undefined}
    >
      {!continuedReview && <div className="assistant-identity">
        <AgentAvatar id={speaker?.id} kind={speaker?.kind} size={32} />
        <strong>{speaker?.kind==='worker'?speaker.label:teamName(speaker?.label??routerLabel)}</strong>
        <Timestamp at={createdAt}/>
        {streaming ? (
          <span className="output-state">
            <span className="live-dot" />
            {L("Writing", "正在输出")}
          </span>
        ) : null}
      </div>}
      <div className="assistant-body">
        <div className="message-line" tabIndex={-1}>
          <div className="message-surface">
            {recipient ? <div className="addressed-message">
              <button type="button" className="chat-mention" onClick={()=>openAgent(recipient.id)}>@{recipient.kind==='router'?teamName(recipient.label):recipient.label}</button>{' '}{body}
            </div> : body}
            <MessageAttachments files={attachments??[]} L={L}/>
          </div>
          <MessageActions id={id}/>
        </div>
        <Reactions id={id}/>
        {run && footerStatus && !(run.state==='waiting' && waitingLabel) ? <span className={'message-status ' + run.state} role="status"><StatusIcon state={run.state} />{footerStatus}</span> : status?.type === 'incomplete' ? <span className="message-status">{status.reason === 'cancelled' ? L('Output stopped','输出已停止') : L('Output interrupted','输出中断')}</span> : null}
      </div>
    </MessagePrimitive.Root><WorkflowCards anchor={id}/></>
  );
}
function StatusIcon({ state }: { state: string }) {
  return ["waiting", "failed", "interrupted"].includes(state) ? (
    <AlertCircle size={17} />
  ) : state === "cancelled" ? (
    <Square size={12} />
  ) : (
    <span className="idle-dot" />
  );
}
function ToolCalls({calls,workers}:{calls:Snapshot['calls'];workers:Worker[]}){
  const {L,lang,routerLabel}=useUI();
  const arrival=useArrival('tools:'+calls[0]!.id,calls[0]!.startedAt);
  return <ToolTrace calls={calls} L={L} locale={lang} arrival={arrival}
    actor={id=>workers.find(w=>w.id===id)?.label??id??routerLabel}/>;
}
function Readiness({ ready }: { ready: Ready | null }) {
  const { L } = useUI();
  if (!ready || ready.ready) return null;
  const messages: Record<string, string> = {
    host_router_required: L(
      "Enable the workspace assistant to start chatting.",
      "启用工作区助手后即可对话。",
    ),
    host_paused: L("The host is paused.", "运行已暂停。"),
    local_source_required: L(
      "Add a local conversation entry.",
      "请添加本地会话入口。",
    ),
    model_credentials_missing: L(
      "Connect a model to start chatting.",
      "请连接对话模型。",
    ),
    model_unavailable: L(
      "Your chat model is unavailable.",
      "对话模型暂不可用。",
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
          L("Set up your assistant to begin.", "请先配置助手。")}
      </span>
      <a
        href={
          ready.code === "host_paused"
            ? "/configure#advanced/host"
            : ready.configurationUrl
        }
      >
        {L("Configure assistant", "配置助手")}
        <ChevronRight size={15} />
      </a>
    </div>
  );
}
function App() {
  const handoffCursor=useRef<HandoffCursor["current"]>(null);
  const chatArrivals = useRef<Arrivals>({conversationId:'',since:Infinity,seen:new Set()});

  const [route, setRoute] = useState(
    location.pathname + location.search + location.hash,
  );
  const [id, setId] = useState<string | null>(null),
    [display, setDisplay] = useState<ChatSpace["display"]>("group"),
    [approvalMode,setApprovalMode] = useState<ChatSpace["approvalMode"]>(),
    [ready, setReady] = useState<Ready | null>(null);
  const spaceVersion=useRef(0);
  const currentId=useRef(id);currentId.current=id;
  const sendTransport=useMemo<Parameters<typeof useMessageSend>[0]>(()=>({
    open:async signal=>{
      const {conversation}=await api<ChatSpace>('/space',{},'POST',signal);
      if(!conversation)throw new ApiError('conversation_missing');
      if(!signal.aborted)handoffCursor.current={id:conversation.id,sequence:conversation.sequence};
      return conversation.id;
    },
    post:(target,input,signal)=>api('/conversations/'+target+'/messages',input,'POST',signal),
    rejection:error=>error instanceof ApiError&&error.status&&error.status>=400&&error.status<500&&![408,429].includes(error.status)?error.code:undefined,
  }),[]);
  const adoptConversation=useCallback((target:string)=>{
    if(currentId.current)return;
    carryInitialDraft(target);
    spaceVersion.current++;
    setId(current=>current??target);
  },[]);
  const sends=useMessageSend(sendTransport,adoptConversation);
  const {recoverInitial,reset:resetSends}=sends;
  const lastReset=useRef(read('roppo.chat.reset'));
  const [navExpanded, setNavExpanded] = useState(read("roppo.navigation.expanded") !== "false");
  useEffect(() => write("roppo.navigation.expanded", String(navExpanded)), [navExpanded]);
  const [lang, setLang] = useState<Language>(
      read("agenthub.configuration.language") === "en" ? "en" : "zh-CN",
    ),
    [dark, setDark] = useState(read("agenthub.configuration.theme") === "dark");
  const L = useCallback(
    (en: string, zh: string) => (lang === "zh-CN" ? zh : en),
    [lang],
  );
  const saveApprovalMode = async (mode: ChatSpace["approvalMode"]) => {
    const saved = await spaceRequest({approvalMode: mode}, "PATCH");
    spaceVersion.current++;
    setApprovalMode(saved.approvalMode);
  };
  const refreshList = useCallback(async () => {
    const version=++spaceVersion.current,space=await spaceRequest();if(version!==spaceVersion.current)return;
    if(space.cleanup && lastReset.current!==space.cleanup.id){
      lastReset.current=space.cleanup.id;resetSends();
      if(read('roppo.chat.reset')!==space.cleanup.id){clearChatDrafts();write('roppo.chat.reset',space.cleanup.id)}
    }
    const linked=location.pathname==="/chat" ? chatLocation(location.hash) : undefined;
    if(!linked?.conversation&&space.conversation){
      recoverInitial(space.conversation.id);
      if(!currentId.current)carryInitialDraft(space.conversation.id);
    }
    setId(linked?.conversation || space.conversation?.id || null);setDisplay(space.display);setApprovalMode(space.approvalMode);
  }, [recoverInitial,resetSends]);
  useEffect(()=>{const change=()=>void refreshList();window.addEventListener('roppo:chat-space',change);return()=>window.removeEventListener('roppo:chat-space',change)},[refreshList]);
  const navigate = useCallback((next: string | null) => {
    setId(next);
    const url = new URL("/chat", location.origin);
    if(location.pathname === "/chat" && location.hash === "#schedules") url.hash = "schedules";

    history.pushState(null, "", url);
    switchView("page",()=>setRoute(url.pathname + url.search + url.hash));
  }, []);
  useEffect(() => {
    const isLibrary = (hash: string) => hash === '#integrations' || /^#integrations\/library(?:\/|$)/.test(hash);
    let previousHash = location.hash;
    let previousPath = location.pathname;
    const sync = () => {
      if (location.hash === "#prompts/memory") history.replaceState(null, "", location.pathname + location.search + "#advanced/memory");
      if (location.pathname === "/configure" && location.hash === "#integrations/library/app") history.replaceState(null, "", "/configure#connectors");
      if (location.pathname === "/chat" && location.search) history.replaceState(null, "", "/chat" + location.hash);
      if (location.pathname === "/chat" && previousHash !== location.hash) void refreshList();
      const next = location.pathname + location.search + location.hash;
      // Filtering and opening library items update the same page, including its live search input.
      if ((previousPath === "/chat" && location.pathname === "/chat") || (isLibrary(previousHash) && isLibrary(location.hash))) setRoute(next);
      else switchView("page", () => setRoute(next));
      previousHash = location.hash;
      previousPath = location.pathname;
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
  const readinessVersion = useRef(0);
  const refreshReady = useCallback(async () => {
    const version = ++readinessVersion.current;
    const next = await api<Ready>("/readiness");
    if (version === readinessVersion.current) setReady(next);
  }, []);
  useEffect(() => {
    const read = () => {
      refreshReady().catch(() => {});
      refreshList().catch(() => {});
    };
    read();
    const timer = setInterval(read, 10000);
    return () => {
      readinessVersion.current++;
      clearInterval(timer);
    };
  }, [refreshList, refreshReady]);
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
        handoffCursor={handoffCursor}
        arrivals={chatArrivals}
        sends={sends}
        key={id ?? "new"}
        {...{
          id,
          display,
          setDisplay,
          approvalMode,
          saveApprovalMode,
          ready,
          refreshReady,
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
  handoffCursor:HandoffCursor;
  arrivals: React.RefObject<Arrivals>;
  sends: ReturnType<typeof useMessageSend>;
  navExpanded: boolean;
  setNavExpanded: (value: boolean) => void;
  display: ChatSpace["display"];
  approvalMode?: ChatSpace["approvalMode"];
  saveApprovalMode: (mode: ChatSpace["approvalMode"]) => Promise<void>;
  setDisplay: (value:ChatSpace["display"])=>void;
  route: string;
  id: string | null;
  ready: Ready | null;
  lang: Language;
  L: (en: string, zh: string) => string;
  dark: boolean;
  setDark: (v: boolean) => void;
  navigate: (id: string | null) => void;
  refreshList: () => Promise<void>;
  refreshReady: () => Promise<void>;
  setLang: (v: Language) => void;
};
const emptySidebarCards: { items: "context"[]; revealing: boolean } = { items: [], revealing: false };
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
  const [trayOpen,setTrayOpen]=useState(()=>read('roppo.chat.pendingTray')==='open');
  const trayButton=useRef<HTMLButtonElement>(null);
  const requestedItem=chatLocation(route.slice(route.indexOf('#')));
  const linkedItem=requestedItem?.conversation===id ? requestedItem?.item : undefined;
  const linkOrigin=useRef<HTMLAnchorElement|null>(null);
  const [linkVisit,setLinkVisit]=useState(0);
  const previousLinkedItem=useRef<string | undefined>(undefined);
  const readHistory=useCallback(<T,>(query:URLSearchParams,signal:AbortSignal)=>api<T>('/conversations/'+id+'/approval-history?'+query,undefined,'GET',signal),[id]);
  const clearSelection=()=>{
    if(chatLocation(location.hash)?.item){
      previousLinkedItem.current=undefined;
      history.replaceState(null,'','#conversation/'+id);
      window.dispatchEvent(new Event('hashchange'));
    }
  };
  const changeTray=(open:boolean)=>{
    if(!open)clearSelection();
    setTrayOpen(open);
    write('roppo.chat.pendingTray',open?'open':'closed');
  };
  const closeTray=()=>{
    changeTray(false);
    const origin=linkOrigin.current;
    const target=origin?.isConnected?origin:trayButton.current;
    target?.focus({preventScroll:true});
    if(target && document.activeElement!==target)requestAnimationFrame(()=>target.focus({preventScroll:true}));
    linkOrigin.current=null;
  };
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
  const [selectedTask,setSelectedTask]=useState<string|null>(null);
  const taskOpener=useRef<HTMLButtonElement>(null);
  const loadTask=useCallback((task:string,signal:AbortSignal) =>
    api<TaskExecutionDetail>('/conversations/'+id+'/task-detail?'+new URLSearchParams({task}),undefined,'GET',signal),[id]);
  useEffect(()=>{
    if(route === '/chat#schedules'){setTeamTab('schedules');setResources(state=>openResource(state,'activity'))}
  },[route]);
  const [browserRequest,setBrowserRequest]=useState<{id:string;takeover:boolean;key:number}>();
  const [panelExpanded, setPanelExpanded] = useState(false);
  const sessionView = useMemo(() => panel && !configuring ? { overview, expanded:panelExpanded, cards:sidebarCards, tab:teamTab, task:selectedTask } : null,
    [panel, configuring, overview, panelExpanded, sidebarCards, teamTab, selectedTask]);
  const sessionPresence = usePanelPresence(sessionView);
  const displayedSession = sessionPresence.view;
  const shownTask = displayedSession?.overview ? displayedSession.task : null;
  const taskPresence = usePanelPresence(shownTask);
  const [pickerRequest,setPickerRequest]=useState(0);
  const creating = useRef(false);
  const choosePanel = async (next: ResourceKind | null, url?: string) => {
    if(next&&panelOverlay&&trayOpen)changeTray(false);
    setSelectedTask(null);
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
  const hash = route.split("#")[1] || "general";
  const general = configuring && hash === "general";
  const workspaceIndex = configuring && hash === "workspace";
  const workspacePage = workspaceGroups(L).flatMap(group => group.items).find(item => hash === item.hash);
  const automationRoute=configuring&&hash==='automations';
  const marketRoute=configuring&&(hash==='integrations'||hash.startsWith('integrations/'));
  const connectorsRoute=configuring&&hash==='connectors';
  const usageStatisticsRoute = configuring && hash === 'tasks/statistics';
  const marketTools=hash==='integrations/tools';
  const views=useWorkspaceViews();
  const pluginId=configuring&&hash.startsWith('plugin/')?hash.slice(7):null;
  const currentView=views.find(view=>view.id===pluginId);
  const pageNames: Record<string, string> = {
    general: L("General", "通用"),
    team: L("Agent team","Agent 团队"),
    tasks: L("Activity", "运行记录"),
    "tasks/active": L("Activity", "运行记录"),
    "tasks/history": L("Activity", "运行记录"),
    "tasks/statistics": L("Usage statistics", "使用统计"),
    attention: L("Activity", "运行记录"),
    "advanced/memory": L("Memory","记忆"),
    "advanced/chat": L("Conversations and context", "对话与上下文"),
    "advanced/configuration": L("Run settings","运行配置"),
    workspace: L("Workspace settings","工作区设置"),
    "models/new": L("New model connection", "新建模型连接"),
    "connections/new": L("New entry", "新建接入"),
    automations: L("Event automations", "事件自动化"),
    execution: L("Model calls", "模型调用"),
    "execution/configuration": L("Agent team", "Agent 团队"),
    deployments: L("Deployments", "部署"),
    models: L("Model connections", "模型连接"),
    connections: L("Conversation entries", "会话入口"),
    integrations: L("Tools & MCP", "工具与 MCP"),
    connectors: L("Connectors", "连接器"),
    prompts: L("Behavior rules", "行为规则"),
    advanced: L("Settings", "设置"),
    usage: L("Usage guide", "使用指引"),
  };
  const pageTitle =
    currentView?.label[lang] ?? workspacePage?.name ??
    (hash.startsWith("execution/configuration/") ? pageNames["execution/configuration"] : undefined) ??
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
    [menu, setMenu] = useState(false),
    [selectedAgent, setSelectedAgent] = useState("router"),
    [panelOverlay, setPanelOverlay] = useState(false),
    [narrow, setNarrow] = useState(
      () => matchMedia("(max-width:800px)").matches,
    );
  const alive = useRef(true),
    fetchVersion = useRef(0),
    messagesRef = useRef<Snapshot["messages"]>([]),
    restoredPending = useRef<ReturnType<typeof savedPending>>(null),
    bodyRef = useRef<HTMLDivElement>(null),
    threadRef = useRef<HTMLDivElement>(null),
    panelOpener = useRef<HTMLElement|null>(null),
    teamButton = useRef<HTMLButtonElement>(null),
    menuButton = useRef<HTMLButtonElement>(null);
  const [quote,setQuote]=useState<DraftQuote|null>(()=>{
    const saved=savedPending(id),draft=read(draftKey(id));
    return savedQuote(id)??(saved&&!p.sends.has(saved.id)&&(!draft||draft.trim()===saved.text)?saved.draftQuote??null:null);
  }),[around,setAround]=useState<string>();
  const locateAfterLoad=useRef<{messageId:string;workflowId?:string}|null>(null),locateRequest=useRef(0),quoteCurrent=useRef(quote);quoteCurrent.current=quote;
  const queuedEnter=useRef<string|null>(null);
  const reactionWrites=useRef(new Map<string,{reactions:string[];promise:Promise<string[]>}>());
  const saveQuote=useCallback((value:DraftQuote|null)=>{quoteCurrent.current=value;setQuote(value);write(quoteKey(id),JSON.stringify(value))},[id]);
  const motion=useChatMotion(threadRef,(id??'new')+':'+selectedAgent+':'+(around??'latest'),!!around,snapshot?.messages.at(-1)?.id);
  useEffect(()=>{const target=locateAfterLoad.current;if(!target||loading)return;const frame=requestAnimationFrame(()=>{if(motion.locate(target.messageId,target.workflowId))locateAfterLoad.current=null});return()=>cancelAnimationFrame(frame)},[snapshot,loading,motion.locate]);
  useEffect(() => {
    const thread=threadRef.current, transcript=thread?.querySelector<HTMLElement>('.transcript');
    if(!thread||!transcript)return;
    const measure=()=>{
      if(!thread.clientWidth)return;
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
        setPanelOverlay(innerWidth <= 800 || entry.contentRect.width < 720);
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  const participants = (snapshot?.participants ?? [{id:"router",label:boot?.routerLabel??"Router",kind:"router" as const,latestMessage:null},...(boot?.workers??[]).map(w=>({id:w.id,label:w.label,kind:"worker" as const,latestMessage:null}))]).map(p=>p.kind==="router"?{...p,label:teamName(p.label)}:p);
  const uploadConversation=useRef<Promise<string>|null>(null),uploadConversationId=useRef(id),[loadingAttachments,setLoadingAttachments]=useState(!!id),[attachmentBlocked,setAttachmentBlocked]=useState(false);
  const ensureConversation=useCallback(()=>{
    if(id)return Promise.resolve(id);
    if(!uploadConversation.current)uploadConversation.current=spaceRequest({},'POST').then(space=>{const target=space.conversation!.id;uploadConversationId.current=target;p.handoffCursor.current={id:target,sequence:space.conversation!.sequence};write(draftKey(target),read(draftKey(null)));return target}).catch(error=>{uploadConversation.current=null;throw error});
    return uploadConversation.current;
  },[id]);
  const attachmentLanguage=useRef(L);attachmentLanguage.current=L;
  const attachmentAdapter=useMemo(()=>createAttachmentAdapter(ensureConversation,boot?.uploads.maxBytes??chatUploadLimits.maxBytes,(en,zh)=>attachmentLanguage.current(en,zh)),[ensureConversation,boot?.uploads.maxBytes]);
  const currentRouter = participants.find(a=>a.id===(snapshot?.routerId??"router"))!;
  const historicalWorker=snapshot?.tasks.find(t=>t.workerId===selectedAgent);
  const selected=participants.find(a=>a.id===selectedAgent)??(historicalWorker?{id:selectedAgent,label:selectedAgent,kind:'worker' as const,latestMessage:null}:currentRouter);
  const readonly = selected.kind === "worker";
  const participantFilter = readonly ? selected.id : undefined;
  const {confirm,has,hasAttachment,reset:resetSends}=p.sends;
  const outgoing=p.sends.messages.filter(m=>(m.conversationId===id||(!m.conversationId&&!requestedItem?.conversation))&&
    !snapshot?.messages.some(message=>message.clientMessageId===m.id));
  const localMessages=readonly||around?[]:outgoing;
  const outstanding=outgoing.find(m=>m.stage!=='accepted');
  const sending=!!outstanding;
  const accepted=outgoing.findLast(m=>m.stage==='accepted')?.id;
  const handoff=useHandoffPlayer(p.handoffCursor,id,snapshot,!configuring&&!around,participantFilter);
  const companionActor=handoff.event?.to??handoff.holder??selected;
  const companionWorker=companionActor.kind==="worker"?companionActor.id:undefined;
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
  const welcome=!readonly&&!loading&&!snapshot?.messages.length&&!localMessages.length&&!running;
  const routerCall = snapshot?.calls.findLast(call => call.runId === run?.id && call.kind === 'router');
  const usage = useCurrentContext(configuring || readonly ? null : id, run?.id, ready?.model, ready?.backend,
    routerCall?.id, routerCall?.usageRevision, running || (overview && sidebarCards.items.includes('context')), loadContext);
  const arrivals = p.arrivals;
  if (snapshot && arrivals.current.conversationId !== snapshot.conversation.id) arrivals.current = {
    conversationId:snapshot.conversation.id, since:Date.now(), seen:new Set(snapshot.messages.map(m=>m.id)),
  };
  const runMessageId = !readonly ? snapshot?.messages.findLast(m => m.runId === run?.id && m.role === 'assistant' && !m.opening && !m.recipient)?.id ?? '' : '';
  const waitingLabel=snapshot ? pendingWaitLabel(snapshot,L,participantFilter) : undefined;
  const standaloneStatus = run && !(run.state==='waiting' && waitingLabel) && !readonly && !runMessageId ? runLabel(run.state,L,waitingLabel??'') : undefined;
  const fail = (e: unknown) => {
    if (alive.current)
      setError(e instanceof ApiError ? e.code : "network_error");
  };
  const refresh = useCallback(async (signal?: AbortSignal) => {
    if (!id) return;
    const version = ++fetchVersion.current;
    const query=new URLSearchParams({withPending:'1'});if(participantFilter)query.set('participant',participantFilter);if(around)query.set('around',around);
    const oldest = messagesRef.current[0]?.sequence;
    if (oldest) query.set("decisionsFrom", String(oldest));
    const data = await api<Snapshot>("/conversations/" + id + "?"+query,undefined,"GET",signal);
    if (signal?.aborted || !alive.current || version !== fetchVersion.current) return;
    const older = messagesRef.current.filter(
      (m) => m.sequence < (data.messages[0]?.sequence ?? Infinity),
    );
    const updates=new Map((data.earlierCards??[]).map(card=>[card.id,card]));
    const messages = [...older.map(m=>updates.has(m.id)?{...m,...updates.get(m.id)}:m), ...data.messages].map(m=>reactionWrites.current.has(m.id)?{...m,reactions:reactionWrites.current.get(m.id)!.reactions}:m);
    messagesRef.current = messages;
    // A history page can arrive while this refresh is in flight.
    const newlyLoadedRuns = new Set(older.filter(m => oldest == null || m.sequence < oldest).map(m => m.runId));
    setSnapshot(previous => {
      const decisions = new Map(data.decisions.map(q => [q.id, q]));
      if (previous?.conversation.id === id && newlyLoadedRuns.size) {
        for (const q of previous.decisions) {
          if (newlyLoadedRuns.has(q.runId) && !decisions.has(q.id)) decisions.set(q.id,q);
        }
      }
      const olderRuns=new Set(older.map(m=>m.runId));
      const cached=previous?.conversation.id===id?previous.approvals.filter(a=>olderRuns.has(a.runId) && a.state!=='pending'):[];
      const approvals=[...new Map([...cached,...data.approvals].map(a=>[a.id,a])).values()];
      return {...data, messages, approvals, decisions:[...decisions.values()], hasMore:messages[0]?.sequence === 1 ? false : data.hasMore};
    });
    setLoading(false);
    setError(code=>code==='sent_refresh_failed'?'':code);
    const received=new Set(messages.flatMap(m=>m.clientMessageId?[m.clientMessageId]:[]));
    confirm(id,received);
    const saved = savedPending(id);
    if (saved && received.has(saved.id)) {
      forgetPending(id,saved.id);
      if (read(draftKey(id)) === saved.text) write(draftKey(id), "");
    }
  }, [id, participantFilter, around, confirm]);
  const refreshCurrent=useRef(refresh);refreshCurrent.current=refresh;
  useEffect(()=>{
    if(!id||!accepted||readonly||around)return;
    const controller=new AbortController();
    const signal=AbortSignal.any([controller.signal,AbortSignal.timeout(5000)]);
    void refreshCurrent.current(signal).catch(()=>{
      if(alive.current&&!controller.signal.aborted)setError('sent_refresh_failed');
    });
    return ()=>controller.abort();
  },[id,accepted,readonly,around]);
  useEffect(() => {
    alive.current = true;
    messagesRef.current=[];setLoading(!!id);setSnapshot(s=>s?{...s,messages:[]}:s);
    if (!id) {
      setConnected(true);
      return () => {
        alive.current = false;
      };
    }
    const lifetime = new AbortController();
    let source: EventSource | undefined;
    let poll: ReturnType<typeof setTimeout> | undefined;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let retryDelay = 1000, reads = 0;
    let failingSince: number | undefined;
    const stop = () => {
      lifetime.abort();
      clearTimeout(poll);
      clearTimeout(retry);
      source?.close();
    };
    const reset = () => {
      stop();
      clearChatDrafts();
      resetSends();
      restoredPending.current = null;
      window.dispatchEvent(new Event("roppo:chat-space"));
    };
    const load = async () => {
      if (lifetime.signal.aborted) return;
      clearTimeout(poll);
      const read = ++reads;
      const current = () => !lifetime.signal.aborted && read === reads;
      try {
        await refresh(AbortSignal.any([lifetime.signal,AbortSignal.timeout(5000)]));
        if (current()) {
          failingSince = undefined;
          setConnected(true);
        }
      } catch (e) {
        if (!current()) return;
        if (e instanceof ApiError && e.code === "conversation_reset") {
          reset();
        } else if (e instanceof ApiError && e.code === "conversation_missing") {
          stop();
          setLoading(false);
          setConnected(true);
          fail(e);
        } else {
          const now = performance.now();
          failingSince ??= now;
          if (now - failingSince >= 1500) {
            setConnected(false);
            setLoading(false);
          }
        }
      } finally {
        if (current()) poll = setTimeout(load, failingSince === undefined ? 8000 : 2000);
      }
    };
    const connect = () => {
      if (lifetime.signal.aborted) return;
      clearTimeout(retry);
      source?.close();
      const connection = new EventSource(
        "/api/chat/conversations/" + id + "/events",
      );
      source = connection;
      const active = () => !lifetime.signal.aborted && source === connection;
      const lost = () => {
        if (!active()) return;
        connection.close();
        source = undefined;
        retry = setTimeout(connect, retryDelay);
        retryDelay = Math.min(8000, retryDelay * 2);
        void load();
      };
      connection.onopen = () => {
        if (active()) {
          retryDelay = 1000;
          void load();
        }
      };
      connection.addEventListener("change", () => {
        if (active()) void load();
      });
      connection.addEventListener("reset", () => { if (active()) reset(); });
      connection.addEventListener("reconnect", lost);
      connection.onerror = lost;
    };
    const resume = () => {
      if (!source || source.readyState === EventSource.CLOSED) connect();
      void load();
    };
    const visible = () => { if (document.visibilityState === "visible") resume(); };
    resume();
    window.addEventListener("offline", load);
    window.addEventListener("online", resume);
    document.addEventListener("visibilitychange", visible);
    return () => {
      alive.current = false;
      fetchVersion.current++;
      stop();
      window.removeEventListener("offline", load);
      window.removeEventListener("online", resume);
      document.removeEventListener("visibilitychange", visible);
    };
  }, [id, refresh, resetSends]);
  const visibleMessages=(snapshot?.messages ?? []).filter(m=>readonly?m.speaker?.id===selected.id||m.recipient?.id===selected.id:display==='group'||!!m.deliveries?.length||!m.recipient&&(m.role==='user'||!m.speaker||m.speaker.id===selected.id));
  const blocks=groupWorkflow(snapshot,visibleMessages,participantFilter);
  const continuedReviews=new Set(visibleMessages.filter((m,i)=>{
    const before=visibleMessages[i-1];
    return m.fileReview && before?.role==='assistant' && before.runId===m.runId && before.speaker?.id===m.speaker?.id && !before.recipient;
  }).map(m=>m.id));
  const inlineAnswers = new Set<string>();
  for (const block of blocks.values()) {
    for (const item of block) {
      if (item.kind === 'question' && item.question.answerMessageId) inlineAnswers.add(item.question.answerMessageId);
    }
  }
  for (const message of visibleMessages) {
    if (message.decision?.answer && message.decision.replyRunId && !message.decision.closed)
      inlineAnswers.add('user:'+message.decision.replyRunId);
  }

  const runtime = useExternalStoreRuntime({
    isRunning: !readonly && !!reply,
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
        continuedReview:continuedReviews.has(m.id),speaker: m.speaker, recipient: m.recipient, attachments: m.attachments, deliveries: m.deliveries,
        inlineAnswer:inlineAnswers.has(m.id) && around!==m.id && !m.attachments?.length, ticketId: m.ticketId, decision:m.decision, fileReview:m.fileReview && {...m.fileReview,name:m.text}, quote: m.quote, reactions: m.reactions, agentReactions: m.agentReactions,
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
      const files=message.attachments??[],attachments=files.map(a=>a.id),sentQuote=quoteCurrent.current;
      if ((!text&&!attachments.length) || sending || readonly) return;
      if(!p.sends.begin({
        conversationId:id??uploadConversationId.current,files,quote:sentQuote,
        input:{text,attachments,quote:quoteReference(sentQuote),locale:navigator.language||lang,
          timeZone:Intl.DateTimeFormat().resolvedOptions().timeZone,openingLocale:lang},
      }))return;
      setError("");
      if(sentQuote)saveQuote(null);
      if(around)setAround(undefined);
      motion.latest();
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
      setSnapshot((s) => (s ? { ...s, messages, approvals:[...new Map([...data.approvals,...s.approvals].map(a=>[a.id,a])).values()], decisions:[...new Map([...data.decisions,...s.decisions].map(q=>[q.id,q])).values()], hasMore: data.hasMore } : s));
    },
  });
  const editOutgoing=async(messageId:string)=>{
    const composer=runtime.thread.composer;
    if(composer.getState().text.trim()||composer.getState().attachments.length||quoteCurrent.current)return;
    const message=p.sends.edit(messageId);
    if(!message)return;
    composer.setText(message.input.text);
    saveQuote(message.quote);
    for(const file of message.files)await composer.addAttachment(file);
    if(message.error)setError(message.error);
    threadRef.current?.querySelector<HTMLTextAreaElement>('.composer-input')?.focus();
  };
  useEffect(()=>{
    if(disabled||queuedEnter.current===null)return;
    const requested=queuedEnter.current;queuedEnter.current=null;
    if(runtime.thread.composer.getState().text===requested)runtime.thread.composer.send();
  },[disabled,runtime]);
  useEffect(()=>{
    if(!id)return;
    let active=true;
    api<{attachments:ChatAttachment[]}>("/conversations/"+id+"/attachments").then(async result=>{
      for(const file of result.attachments)if(active&&!hasAttachment(file.id)&&!runtime.thread.composer.getState().attachments.some(a=>a.id===file.id))await runtime.thread.composer.addAttachment(attachmentParts(file));
    }).catch(fail).finally(()=>{if(active)setLoadingAttachments(false)});
    return()=>{active=false};
  },[runtime,id,hasAttachment]);
  useEffect(() => {
    const saved=savedPending(id);
    restoredPending.current=saved&&!has(saved.id)?saved:null;
    runtime.thread.composer.setText(read(draftKey(id))||restoredPending.current?.text||'');
    return runtime.thread.composer.subscribe(() => {
      const composer=runtime.thread.composer.getState(),text=composer.text;write(draftKey(id),text);
      setAttachmentBlocked(composer.attachments.some(a=>a.status.type==='running'||a.status.type==='incomplete'));
      if(uploadConversationId.current&&uploadConversationId.current!==id)write(draftKey(uploadConversationId.current),text);
    });
  }, [runtime, id, has]);
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
    const saved = restoredPending.current;
    if (
      saved &&
      snapshot?.messages.some((m) => m.clientMessageId === saved.id)
    ) {
      restoredPending.current = null;
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
        } else if (panel && overview && selectedTask && !configuring) {
          backToTasks();
        } else if (trayOpen && !configuring && !(panel && (panelOverlay || panelExpanded))) {
          closeTray();
        } else if (sidebarCards.revealing) {
          dismissCard(sidebarCards.items[0]!);
        } else if (panel) {
          closePanel();
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [menu, panel, resource, sidebarCards, panelOverlay, closeNavigation, trayOpen, configuring, panelExpanded, overview, selectedTask]);
  useEffect(() => {
    if (narrow && menu)
      document
        .querySelector<HTMLElement>('#function-navigation button, #function-navigation a')
        ?.focus();
  }, [narrow, menu]);
  const current = snapshot?.conversation;
  const pendingCards=snapshot?.conversation.id===id?(snapshot?.pendingCards??[]):[];
  const trayVisible=trayOpen&&!configuring&&!((panelOverlay||panelExpanded)&&panel);
  const trayView = useMemo(() => trayVisible ? { linkedItem, linkVisit } : null, [trayVisible, linkedItem, linkVisit]);
  const trayPresence = usePanelPresence<NonNullable<typeof trayView>, HTMLDivElement>(trayView, '#pending-tray');
  const displayedTray = trayPresence.view;
  const displayedPendingItem = displayedTray?.linkedItem;
  useEffect(()=>{
    if(linkedItem){
      changeTray(true);
      if((panelOverlay||panelExpanded)&&panel)void choosePanel(null);
    }else if(previousLinkedItem.current){
      setTrayOpen(false);
      write('roppo.chat.pendingTray','closed');
    }
    previousLinkedItem.current=linkedItem;
  },[linkedItem]);
  const toggleTray=()=>{
    linkOrigin.current=null;
    if(!trayVisible&&(panelOverlay||panelExpanded)&&panel)void choosePanel(null);
    changeTray(!trayVisible);
    if(!trayVisible)requestAnimationFrame(()=>document.getElementById('pending-tray')?.focus({preventScroll:true}));
  };
  const selectAgent=(agentId:string)=>{locateRequest.current++;locateAfterLoad.current=null;setAround(undefined);setSelectedAgent(agentId);setSidebarCards(emptySidebarCards)};
  function revealCard(card: "context") {
    if(panelOverlay&&trayOpen)changeTray(false);
    setSelectedTask(null);
    if (!panel) {
      panelOpener.current = threadRef.current?.querySelector<HTMLElement>('.composer-input') ?? null;
      setTeamTab('activity');
      setResources(state => openResource(state, 'activity'));
    }
    setSidebarCards(state => ({items:[card, ...state.items.filter(item => item !== card)], revealing:true}));
    requestAnimationFrame(() => bodyRef.current?.querySelector('.team-tab-content')?.scrollTo({top:0, behavior:'instant'}));
  }
  function dismissCard(card: "context") {
    const items = sidebarCards.items.filter(item => item !== card);
    const revealing = sidebarCards.revealing && items.length > 0;
    setSidebarCards({items, revealing});
    restorePanelFocus(() => panelOverlay
        ? bodyRef.current?.querySelector<HTMLElement>('#session-panel [role=tab][aria-selected=true]:not([tabindex="-1"])')
        : threadRef.current?.querySelector<HTMLElement>('.composer-input'));
  }
  function restorePanelFocus(target: () => HTMLElement | null | undefined) {
    const previous = document.activeElement;
    requestAnimationFrame(() => {
      if (document.activeElement === previous || document.activeElement === document.body)
        target()?.focus({preventScroll: true});
    });
  }
  function closePanel() {
    void choosePanel(null);
    restorePanelFocus(() => panelOpener.current?.isConnected ? panelOpener.current : teamButton.current);
  }
  function backToTasks() {
    setSelectedTask(null);
    restorePanelFocus(() => taskOpener.current?.isConnected ? taskOpener.current : document.getElementById('team-tab-activity'));
  }
  const readAgent=(agentId:string)=>{selectAgent(agentId);void choosePanel(null);requestAnimationFrame(()=>threadRef.current?.querySelector<HTMLElement>('.worker-readonly button,.composer-input')?.focus({preventScroll:true}))};
  const quoteMessage=(value:DraftQuote)=>{
    saveQuote(value);selectAgent(currentRouter.id);
    requestAnimationFrame(()=>threadRef.current?.querySelector<HTMLTextAreaElement>('.composer-input')?.focus({preventScroll:true}));
  };
  const locateMessage=async(messageId:string,workflowId?:string)=>{
    const version=++locateRequest.current;
    locateAfterLoad.current=null;
    if((!workflowId||snapshot?.messages.some(m=>m.id===messageId))&&motion.locate(messageId,workflowId))return;
    try{
      const data=await api<Snapshot>('/conversations/'+id+'?around='+encodeURIComponent(messageId));
      if(!alive.current||version!==locateRequest.current)return;
      const message=data.messages.find(m=>m.id===messageId);
      if(!message)throw new ApiError("message_missing");
      const participant=message.speaker?.kind==='worker'?message.speaker.id:message.recipient?.kind==='worker'?message.recipient.id:currentRouter.id;
      locateAfterLoad.current={messageId,workflowId};
      if(display==='agents'||readonly)setSelectedAgent(participant);
      setAround(messageId);
    }catch(e){if(version===locateRequest.current)fail(e)}
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
      try{confirmed=(await api<{reactions:string[]}>('/conversations/'+id+'/reactions',{messageId,emoji,active,timeZone:Intl.DateTimeFormat().resolvedOptions().timeZone})).reactions}catch{if(alive.current)setError('reaction_failed')}
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
        openFile:setFile,openAgent:readAgent,
        run: run ?? null,
        runMessageId,waitingLabel:waitingLabel??'',
        arrivals:arrivals.current,
      }}
    >
      <WorkflowProvider value={{L,blocks,readonly,conversation:id??'',pendingIds:new Set(pendingCards.map(c=>c.id)),actor:id=>participants.find(p=>p.id===id)?.label??id,tools:calls=><ToolCalls calls={calls} workers={workers}/>,
        decide:async(messageId,answer)=>{try{await api('/conversations/'+id+'/decisions',{messageId,answer,locale:navigator.language||lang,timeZone:Intl.DateTimeFormat().resolvedOptions().timeZone});if(matchMedia('(max-width:600px)').matches)closeTray()}finally{await refresh()}},
        answerWorker:body=>api('/conversations/'+id+'/decisions',body),refresh,
        readDraft:(messageId)=>api('/conversations/'+id+'/file-reviews?message='+encodeURIComponent(messageId)),
        reviewFile:async(messageId,state)=>{try{await api('/conversations/'+id+'/file-reviews',{messageId,state});closeTray()}finally{await refresh()}},
        authorize:async(request,value)=>{try{await api('/conversations/'+id+'/approvals',{id:request,value});if(typeof value==='string'||matchMedia('(max-width:600px)').matches)closeTray()}finally{await refresh()}}
      }}><AssistantRuntimeProvider runtime={runtime}>
        <InteractionProvider L={L} messages={snapshot?.messages??[]} reply={quoteMessage} react={reactMessage} locate={messageId=>void locateMessage(messageId)}>
        <div
          className={
            "chat-shell studio-shell" +
            (menu ? " menu-open" : "") +
            (displayedSession ? " team-open" : "") +
            (configuring && navExpanded ? " functions-expanded" : "") +
            (configuring ? " management-mode" : " floating-chat") +
            (display === "group" ? " conversation-list-hidden" : "")
          }
        >
          <a className="skip-link" href="#conversation">
            {configuring
              ? L("Skip to content", "跳转到内容")
              : L("Skip to conversation", "跳转到对话")}
          </a>
          {configuring && <StudioRail L={L} hash={hash} expanded={navExpanded} expand={setNavExpanded}
            mobile={narrow} open={menu} close={closeNavigation}
            views={views.map(v=>({id:v.id,label:v.label[lang]}))}
            user={boot?.user?.displayName || L("Local account","本地账户")}/>}
          {configuring && menu ? (
            <button
              className="nav-scrim"
              aria-label={L("Close navigation", "关闭导航")}
              onClick={closeNavigation}
            />
          ) : null}
          <main
            className="chat-main"
            data-settings-view={configuring ? hash : undefined}
            id="conversation"
            tabIndex={-1}
            inert={configuring && narrow && menu}
          >
            {configuring && (!connectorsRoute || narrow) ? <header className="chat-header">
              <button
                className="icon-button mobile-menu"
                ref={menuButton}
                onClick={() => setMenu(true)}
                aria-label={L("Open navigation", "打开导航")}
                aria-expanded={menu}
                aria-controls="function-navigation"
              >
                <Menu size={20} />
              </button>
              {!connectorsRoute && <div className="studio-breadcrumb">
                <span>{L("Settings","设置")}</span><ChevronRight size={14}/>
                {workspacePage && <><a href="/configure#workspace">{L("Workspace settings","工作区设置")}</a><ChevronRight size={14}/></>}
                {hash === "advanced/chat" && <><a href="/configure#general">{L("General", "通用")}</a><ChevronRight size={14}/></>}
                <strong>{pageTitle}</strong>
              </div>}
            </header> : null}
            <SwitchView scope="page"><div className="workspace-page-stage" data-route={route}>
            {workspaceIndex && <WorkspaceSettings L={L}/>}
            {general?<General onDisplayChange={p.setDisplay} openWorkspaces={()=>{history.pushState(null,"","/configure#advanced/host");window.dispatchEvent(new Event("roppo:navigation"));setPickerRequest(v=>v+1)}} dark={dark} setDark={setDark} lang={lang} setLang={setLang} display={display} L={L}/>:null}
            {marketRoute?<Suspense fallback={<div className="workspace-view-placeholder" role="status">{L("Loading plugins…","正在加载插件…")}</div>}><PluginMarketplace route={hash} language={lang}/></Suspense>:null}
            {connectorsRoute?<Suspense fallback={<div className="workspace-view-placeholder" role="status">{L("Loading connectors…","正在读取连接器…")}</div>}><ConnectorsWorkspace language={lang}/></Suspense>:null}
            {automationRoute?<Suspense fallback={<div className="workspace-view-placeholder" role="status">{L("Loading automations…","正在加载自动化…")}</div>}><AutomationWorkspace language={lang}/></Suspense>:null}
            {usageStatisticsRoute && <Suspense fallback={<div className="workspace-view-placeholder" role="status">{L("Loading usage statistics…", "正在读取使用统计…")}</div>}>
              <UsageStatisticsPage language={lang}/>
            </Suspense>}
            <Configuration
              visible={configuring&&!general&&!workspaceIndex&&!automationRoute&&!connectorsRoute&&!usageStatisticsRoute&&!pluginId&&(!marketRoute||marketTools)}
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
              <div className="conversation-lane">
                <div className="chat-float chat-float-start roppo-ui">
                  <a href="/configure#general" className="icon-button" aria-label={L("Settings","设置")} title={L("Settings","设置")}><Settings size={19}/></a>
                  {display === "agents" && <ChatMemberPicker L={L} participants={participants} selected={selected.id} select={readAgent}/>}
                </div>
                <ChatCompanion actor={companionActor} event={handoff.event} onFinish={handoff.finish}
                  status={companionStatus(snapshot,L,{participantId:companionWorker,connected,loading:loading&&!localMessages.length})} L={L}
                  onOpen={()=>{setTeamTab("activity");void choosePanel("activity")}}/>
                <div className="chat-float chat-float-end">
                  <button ref={trayButton} type="button" className={'icon-button pending-trigger'+(trayVisible?' selected':'')}
                    aria-label={L('Pending requests','待处理事项')+(pendingCards.length?' · '+pendingCards.length:'')}
                    title={L('Pending requests','待处理事项')} aria-expanded={trayVisible} aria-controls="pending-tray" onClick={toggleTray}>
                    <Inbox size={19}/>{pendingCards.length>0&&<span className="pending-badge" aria-hidden="true">{pendingCards.length>99?'99+':pendingCards.length}</span>}
                  </button>
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
                </div>
                {displayedTray&&<div ref={trayPresence.ref} className="tray-presence" data-closing={trayPresence.closing||undefined}
                  inert={trayPresence.closing} aria-hidden={trayPresence.closing||undefined}>
                  <button type="button" className="pending-backdrop" tabIndex={-1} aria-label={L('Close pending panel','关闭待处理面板')} onClick={closeTray}/>
                  <PendingTray key={(id??'')+':'+displayedTray.linkVisit} read={readHistory} clearSelection={clearSelection}
                  linkedAnswer={!!displayedPendingItem && (displayedPendingItem.startsWith('decision:') || !!snapshot?.decisions.some(q=>q.id===displayedPendingItem) || !!snapshot?.approvals.some(a=>a.id===displayedPendingItem && a.method==='item/tool/requestUserInput'))}
                  cards={pendingCards} selectedId={displayedPendingItem} loading={!!id && (loading || snapshot?.conversation.id !== id)} close={closeTray} locate={card=>{
                  changeTray(false);
                  if(panel && (panelOverlay || panelExpanded))void choosePanel(null);
                  if('messageId' in card)void locateMessage(card.messageId,card.id);
                  else void locateMessage(card.id);
                }}/></div>}
                <ThreadPrimitive.Root
                  onClickCapture={event=>{
                    const target=event.target;
                    if(!(target instanceof Element)||event.button!==0||event.metaKey||event.ctrlKey||event.shiftKey||event.altKey)return;
                    const link=target.closest<HTMLAnchorElement>('a.pending-action-link');
                    if(link){linkOrigin.current=link;setLinkVisit(n=>n+1);changeTray(true)}
                  }}
                  ref={threadRef}
                  className="thread"
                  data-welcome={welcome || undefined}
                  inert={(!overview && panelExpanded) || (panelOverlay && !!panel)}
                >
                  <ThreadPrimitive.Viewport className="transcript" autoScroll={false} scrollToBottomOnRunStart={false} scrollToBottomOnInitialize={false} scrollToBottomOnThreadSwitch={false}>
                    <div className="transcript-inner">
                      <ThreadPrimitive.LoadEarlier className="load-earlier">
                        {L("Load earlier messages", "加载更早的消息")}
                      </ThreadPrimitive.LoadEarlier>
                      {loading && !localMessages.length ? (
                        <div className="loading" role="status">
                          <LoaderCircle size={22} className="spin" />
                          {L("Loading conversation", "正在加载会话")}
                        </div>
                      ) : null}
                      {!localMessages.length&&<ThreadPrimitive.Empty>
                        <div className="empty-state">
                          {readonly?<AgentAvatar id={selected.id} kind="worker" size={64}/>:null}
                          <h1>
                            {readonly ? L("No collaboration messages yet", "暂无协作消息") : L("What shall we work on?", "今天想做什么？")}
                          </h1>
                        </div>
                      </ThreadPrimitive.Empty>}
                      <ThreadPrimitive.Messages
                        components={{ UserMessage, AssistantMessage }}
                      />
                      {localMessages.map(message=><OutgoingBubble key={message.id} message={message} draftQuoted={!!quote}
                        retry={()=>p.sends.retry(message.id)} edit={()=>void editOutgoing(message.id).catch(fail)}/>)}
                      <WorkflowCards anchor="pending"/>
                      {(snapshot?.browsers??[]).filter(b=>(!b.ended||b.runId===run?.id)&&(!readonly||b.workerId===selected.id)).map(b=><div className="chat-browser" key={b.id}>
                        <Globe size={20}/><div><strong>{b.title||L('Browser','浏览器')}</strong><span>{b.handoffReason|| (b.ended?L('Task ended','任务已结束'):(b.control==='worker'||b.control==='router')?L('Agent is browsing','Agent 正在浏览'):L('Waiting for you','等待你操作'))}</span></div>
                        <button onClick={()=>{setBrowserRequest({id:b.id,takeover:!b.ended&&b.control==='paused',key:Date.now()});void choosePanel('browser')}}>{!b.ended&&b.control==='paused'?<Hand size={15}/>:null}{!b.ended&&b.control==='paused'?L('Take control','接管'):L('View page','查看网页')}</button>
                      </div>)}
                      {run&&standaloneStatus?<div className="run-activity" aria-live="polite">
                        <div className={"run-status "+run.state}><StatusIcon state={run.state}/><span>{standaloneStatus}</span></div>
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
                          "Can’t update the conversation. Reconnecting…",
                          "暂时无法更新对话，正在重连…",
                        )}
                      </div>
                    ) : null}
                    <Readiness ready={ready} />
                    {readonly ? <div className="composer worker-readonly"><textarea disabled rows={1} aria-label={L("Message "+currentRouter.label+" to continue", "请与 "+currentRouter.label+" 对话")} placeholder={L("Message "+currentRouter.label+" to continue", "请与 "+currentRouter.label+" 对话")}/><button onClick={()=>selectAgent(currentRouter.id)}>{L("Message "+currentRouter.label, "前往 "+currentRouter.label)}</button></div> : <ComposerPrimitive.AttachmentDropzone asChild disabled={sending||loadingAttachments||!ready?.ready}><ComposerPrimitive.Root className="composer">
                      <QuotePreview quote={quote} L={L} onClear={()=>saveQuote(null)}/>
                      <div className="composer-attachments"><ComposerPrimitive.Attachments components={{Attachment:ComposerAttachment}}/></div>
                      <ComposerControls visible={!configuring} L={L} sending={outstanding?.stage==='sending'} router={currentRouter.label}
                        model={ready?.model || ready?.backend} mode={p.approvalMode} usage={usage} modelBusy={!!reply}
                        uploadDisabled={sending || loadingAttachments || !ready?.ready}
                        onContext={() => revealCard('context')} saveMode={p.saveApprovalMode}
                        onModelSaved={id ? refresh : p.refreshReady}
                        onEnter={text => {
                          if ((sending || loading || loadingAttachments) && text.trim()) { queuedEnter.current = text; return }
                          runtime.thread.composer.send();
                        }}/>
                    </ComposerPrimitive.Root></ComposerPrimitive.AttachmentDropzone>}
                  </div>
                  {welcome ? <div className="starter-actions">
                    {[
                      {Icon:ListChecks,label:L("Make a checklist","整理清单"),text:L("Prepare a launch checklist grouped by owner.","把发布前的检查项按负责人整理成一份清单。")},
                      {Icon:UsersRound,label:L("Meet the team","查看分工"),text:L("Which Agents are in this workspace and what can they do?","我的团队里有哪些 Agent？各自负责什么？")},
                      {Icon:FileText,label:L("Draft a brief","起草简报"),text:L("Draft a short progress brief for this release.","帮我起草一份发布进度简报。")}
                    ].map(({Icon,label,text})=><button key={label} onClick={()=>{runtime.thread.composer.setText(text);threadRef.current?.querySelector<HTMLTextAreaElement>('.composer-input')?.focus()}}><Icon size={16}/>{label}</button>)}
                  </div>:null}
                </ThreadPrimitive.Root>
              </div>
              {displayedSession && <aside ref={sessionPresence.ref} id="session-panel" aria-label={L('Session panel', '会话面板')}
                data-closing={sessionPresence.closing||undefined} inert={sessionPresence.closing} aria-hidden={sessionPresence.closing||undefined}
                className={'session-panel '+(displayedSession.overview ? 'chat-inspector team-drawer task-drawer' : 'resource-workspace'+(displayedSession.expanded?' expanded':''))}>
                <SidebarSeparator pane="panel" controls="session-panel" label={L("Session panel","会话面板")}/>
                {displayedSession.overview && <div className="task-drawer-stack">
                  <div className="task-drawer-layer task-overview-layer" data-inactive={!!shownTask||undefined} inert={!!shownTask} aria-hidden={!!shownTask||undefined}>
                  <TeamOverview active={!sessionPresence.closing} snapshot={snapshot} participants={participants} routerLabel={currentRouter.label} lang={lang} L={L}
                  tab={displayedSession.cards.revealing ? 'activity' : displayedSession.tab} focusOnOpen={!displayedSession.cards.revealing}
                  setTab={tab => {
                    if (sidebarCards.revealing && tab !== 'activity') void choosePanel('activity');
                    setTeamTab(tab);
                  }}
                  close={closePanel} select={readAgent} openFile={setFile} resource={kind=>void choosePanel(kind)}
                  openTask={id ? (activity,source)=>{
                    taskOpener.current=source;
                    setSidebarCards(state=>state.revealing?{...state,revealing:false}:state);
                    setSelectedTask(activity.id);
                  } : undefined}
                  cards={!configuring && !readonly && displayedSession.cards.items.length > 0 && displayedSession.cards.items.map(card =>
                    card === 'context' && <ContextCard key={JSON.stringify([card, id, current?.backend, current?.model])}
                      current={usage} L={L} focusOnReveal={panelOverlay && displayedSession.cards.revealing}
                      onClose={()=>dismissCard(card)} />
                  )}
                  locateMessage={messageId=>{if(panelOverlay)void choosePanel(null);requestAnimationFrame(()=>void locateMessage(messageId))}}
                  changeSchedule={async (planId,expectedRevision,patch)=>{
                    try{await api('/conversations/'+id+'/schedules',{id:planId,expectedRevision,operationId:crypto.randomUUID(),...patch},'PATCH')}finally{await refresh()}
                  }}
                  />
                  </div>
                  {id && taskPresence.view && <Suspense fallback={<div className="task-drawer-layer task-run-scroll"><p className="task-run-note" role="status">{L('Loading task history…','正在读取任务记录…')}</p></div>}>
                    <TaskDetail key={taskPresence.view} id={taskPresence.view} load={loadTask}
                    active={!sessionPresence.closing&&!taskPresence.closing} closing={taskPresence.closing}
                    layerRef={taskPresence.ref} back={backToTasks} close={closePanel} locale={lang} L={L} selectAgent={readAgent}
                    agentName={id=>id ? participants.find(agent=>agent.id===id)?.label??id : teamName(currentRouter.label)}/>
                  </Suspense>}
                </div>}
                <ResourceWorkspace
                  hidden={displayedSession.overview}
                  state={resources}
                  browser={id && !configuring ? {conversationId:id, requestedSession:browserRequest,
                    requestedUrl:pendingWebsite, onUrlConsumed:consumeWebsite} : undefined}
                  onChange={setResources}
                  onOpen={(kind, url) => {
                    if (kind === 'activity') setTeamTab('activity');
                    void choosePanel(kind, url);
                  }}
                  expanded={displayedSession.expanded}
                  onExpand={() => setPanelExpanded(!panelExpanded)}
                  onClose={closePanel}
                  L={L}
                >
                  {activeTool === "files" ? (
                    <FilesPanel conversationId={id} deliveries={snapshot?.deliveries ?? []} openFile={setFile} L={L} />
                  ) : null}
                </ResourceWorkspace>
              </aside>}
            </div>
            </div></SwitchView>
          </main>
        </div>
        {file?<DeliveryFileViewer key={file.id} file={deliveryFile(file)} L={L} onClose={()=>setFile(null)}/>:null}
        </InteractionProvider>
      </AssistantRuntimeProvider></WorkflowProvider>
    </Context.Provider>
  );
}
createRoot(document.getElementById("root")!).render(<App />);
