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
  Check,
  LoaderCircle,
  Square,
  AlertCircle,
  RefreshCw,
  Globe,
  Hand,
} from "lucide-react";
import type { ChatSessions } from "../../src/chat.ts";
import {DeliveryCard,FileViewer,TeamOverview,teamName,type TeamTab} from './team-view.tsx';
import type {ChatDelivery} from '../../src/chat-deliveries.ts';
import {WorkflowProvider,WorkflowCards,RouterDecision,FileReviewCard,PendingTray,groupWorkflow} from './workflow-cards.tsx';
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
import { ChatMemberPicker, StudioRail, General, TeamSettings } from "./studio-navigation.tsx";
import { SwitchView, switchView } from "../ui";
import { SidebarSeparator } from "./sidebar-separator.tsx";
import {lazy,Suspense} from "react";
const PluginMarketplace=lazy(()=>import("./plugin-marketplace.tsx").then(m=>({default:m.PluginMarketplace})));
const AutomationWorkspace=lazy(()=>import("./automations.tsx").then(m=>({default:m.AutomationWorkspace})));
import {spaceRequest,clearChatDrafts,type ChatSpace} from './chat-settings.tsx';
import { Configuration } from "./configuration.tsx";
import {WorkspaceView,useWorkspaceViews} from './workspace-view.tsx';
import { FilesPanel } from "./files.tsx";
import { AgentAvatar } from "./agent-avatar.tsx";

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
import "./sidebar-resize.css";
import "./studio.css";
import "./settings-design.css";
import "./pending-tray.css";
import "./floating-chat.css";
import { WorkspaceSettings, workspaceGroups } from "./workspace-settings.tsx";

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
  return ({waiting:L('Waiting for your input','等待你的补充'),completed:L('Complete','已完成'),cancel_requested:L('Stopping…','正在停止…'),cancelled:L('Stopped','已停止'),failed:L('Couldn’t finish. Send a follow-up to retry.','未能完成，可补充消息后重试。')} as Record<string,string>)[state];
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
  const { L, run, runMessageId, routerLabel, openFile,openAgent } = useUI(),
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
    footerStatus = run && runMessageId === id ? runLabel(run.state,L) : undefined;
  if (streaming && !hasText) return <WorkflowCards anchor={id}/>;
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
        <strong>{speaker?.kind==='worker'?speaker.label:teamName(speaker?.label??routerLabel)}</strong>
        <Timestamp at={createdAt}/>
        {streaming ? (
          <span className="output-state">
            <span className="live-dot" />
            {L("Writing", "正在输出")}
          </span>
        ) : null}
      </div>
      <div className="assistant-body">
        {recipient ? <div className="addressed-message">
          <button type="button" className="chat-mention" onClick={()=>openAgent(recipient.id)}>@{recipient.kind==='router'?teamName(recipient.label):recipient.label}</button>{' '}{body}
        </div> : body}
        <MessageAttachments files={attachments??[]} L={L}/>
        <Reactions id={id}/>
        <div className="message-footer">
          {run && footerStatus ? <span className={'message-status ' + run.state} role="status"><StatusIcon state={run.state} />{footerStatus}</span> : status?.type === 'incomplete' ? <span className="message-status">{status.reason === 'cancelled' ? L('Output stopped','输出已停止') : L('Output interrupted','输出中断')}</span> : null}
        <MessageActions id={id}/>
        </div>
      </div>
    </MessagePrimitive.Root><WorkflowCards anchor={id}/></>
  );
}
function StatusIcon({ state }: { state: string }) {
  return state === "completed" ? (
    <Check className="success" size={17} />
  ) : ["waiting", "failed", "interrupted"].includes(state) ? (
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
  const chatArrivals = useRef<Arrivals>({conversationId:'',since:Infinity,seen:new Set()});

  const [route, setRoute] = useState(
    location.pathname + location.search + location.hash,
  );
  const [id, setId] = useState<string | null>(null),
    [display, setDisplay] = useState<ChatSpace["display"]>("group"),
    [approvalMode,setApprovalMode] = useState<ChatSpace["approvalMode"]>(),
    [ready, setReady] = useState<Ready | null>(null);
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
  const spaceVersion=useRef(0);
  const saveApprovalMode = async (mode: ChatSpace["approvalMode"]) => {
    const saved = await spaceRequest({approvalMode: mode}, "PATCH");
    spaceVersion.current++;
    setApprovalMode(saved.approvalMode);
  };
  const refreshList = useCallback(async () => {
    const version=++spaceVersion.current,space=await spaceRequest();if(version!==spaceVersion.current)return;
    if(space.cleanup && read("roppo.chat.reset") !== space.cleanup.id){clearChatDrafts();write("roppo.chat.reset",space.cleanup.id)}
    const linked=location.pathname==="/chat" && /^#conversation\/([a-f0-9-]{36})$/.exec(location.hash);
    setId((linked && linked[1]) || space.conversation?.id || null);setDisplay(space.display);setApprovalMode(space.approvalMode);
  }, []);
  useEffect(()=>{const change=()=>void refreshList();window.addEventListener('roppo:chat-space',change);return()=>window.removeEventListener('roppo:chat-space',change)},[refreshList]);
  const navigate = useCallback((next: string | null) => {
    setId(next);
    const url = new URL("/chat", location.origin);

    history.pushState(null, "", url);
    switchView("page",()=>setRoute(url.pathname + url.search + url.hash));
  }, []);
  useEffect(() => {
    const isLibrary = (hash: string) => hash === '#integrations' || /^#integrations\/library(?:\/|$)/.test(hash);
    let previousHash = location.hash;
    const sync = () => {
      if (location.hash === "#prompts/memory") history.replaceState(null, "", location.pathname + location.search + "#advanced/memory");
      if (location.pathname === "/chat" && location.search) history.replaceState(null, "", "/chat" + location.hash);
      if (location.pathname === "/chat" && previousHash !== location.hash) void refreshList();
      const next = location.pathname + location.search + location.hash;
      // Filtering and opening library items update the same page, including its live search input.
      if (isLibrary(previousHash) && isLibrary(location.hash)) setRoute(next);
      else switchView("page", () => setRoute(next));
      previousHash = location.hash;
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
        arrivals={chatArrivals}
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
  arrivals: React.RefObject<Arrivals>;
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
  const changeTray=(open:boolean)=>{
    setTrayOpen(open);
    write('roppo.chat.pendingTray',open?'open':'closed');
  };
  const closeTray=()=>{changeTray(false);trayButton.current?.focus({preventScroll:true})};
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
  const [panelExpanded, setPanelExpanded] = useState(false);
  const [pickerRequest,setPickerRequest]=useState(0);
  const creating = useRef(false);
  const choosePanel = async (next: ResourceKind | null, url?: string) => {
    if(next&&panelOverlay&&trayOpen)changeTray(false);
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
  const teamSettings = configuring && hash === "team";
  const workspaceIndex = configuring && hash === "workspace";
  const workspacePage = workspaceGroups(L).flatMap(group => group.items).find(item => hash === "advanced/" + item.route);
  const automationRoute=configuring&&hash==='automations';
  const marketRoute=configuring&&(hash==='integrations'||hash.startsWith('integrations/'));
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
    attention: L("Activity", "运行记录"),
    "advanced/memory": L("Memory","记忆"),
    workspace: L("Workspace settings","工作区设置"),
    "models/new": L("New model connection", "新建模型连接"),
    "connections/new": L("New entry", "新建接入"),
    automations: L("Event automations", "事件自动化"),
    execution: L("Agent team", "Agent 团队"),
    deployments: L("Deployments", "部署"),
    models: L("Model connections", "模型连接"),
    connections: L("Conversation entries", "会话入口"),
    integrations: L("Tools & MCP", "工具与 MCP"),
    prompts: L("Behavior rules", "行为规则"),
    advanced: L("Settings", "设置"),
    usage: L("Usage guide", "使用指引"),
  };
  const pageTitle =
    currentView?.label[lang] ?? workspacePage?.name ??
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
  const routerCall = snapshot?.calls.findLast(call => call.runId === run?.id && call.kind === 'router');
  const usage = useCurrentContext(configuring || readonly ? null : id, run?.id, ready?.model, ready?.backend,
    routerCall?.id, running || (overview && sidebarCards.items.includes('context')), loadContext);
  const arrivals = p.arrivals;
  if (snapshot && arrivals.current.conversationId !== snapshot.conversation.id) arrivals.current = {
    conversationId:snapshot.conversation.id, since:Date.now(), seen:new Set(snapshot.messages.map(m=>m.id)),
  };
  const reactionOnly = run?.state==='completed' && snapshot?.messages.some(m=>m.runId===run.id && m.role==='user' && m.agentReactions?.length);
  const runMessageId = !readonly ? snapshot?.messages.findLast(m => m.runId === run?.id && m.role === 'assistant' && !m.opening && !m.recipient)?.id ?? '' : '';
  const standaloneStatus = run && !readonly && !runMessageId && !reactionOnly ? runLabel(run.state,L) : undefined;
  const fail = (e: unknown) => {
    if (alive.current)
      setError(e instanceof ApiError ? e.code : "network_error");
  };
  const refresh = useCallback(async () => {
    if (!id) return;
    const version = ++fetchVersion.current;
    const query=new URLSearchParams({withPending:'1'});if(participantFilter)query.set('participant',participantFilter);if(around)query.set('around',around);
    const oldest = messagesRef.current[0]?.sequence;
    if (oldest) query.set("decisionsFrom", String(oldest));
    const data = await api<Snapshot>("/conversations/" + id + "?"+query);
    if (!alive.current || version !== fetchVersion.current) return;
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
      return {...data, messages, decisions:[...decisions.values()], hasMore:messages[0]?.sequence === 1 ? false : data.hasMore};
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
          openingLocale: lang,
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
      setSnapshot((s) => (s ? { ...s, messages, decisions:[...new Map([...data.decisions,...s.decisions].map(q=>[q.id,q])).values()], hasMore: data.hasMore } : s));
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
  }, [menu, panel, resource, sidebarCards, panelOverlay, closeNavigation, trayOpen, configuring, panelExpanded]);
  useEffect(() => {
    if (narrow && menu)
      document
        .querySelector<HTMLElement>('#function-navigation button, #function-navigation a')
        ?.focus();
  }, [narrow, menu]);
  const current = snapshot?.conversation;
  const pendingCards=snapshot?.conversation.id===id?(snapshot?.pendingCards??[]):[];
  const trayVisible=trayOpen&&!configuring&&!((panelOverlay||panelExpanded)&&panel);
  const toggleTray=()=>{
    if(!trayVisible&&(panelOverlay||panelExpanded)&&panel)void choosePanel(null);
    changeTray(!trayVisible);
    if(!trayVisible)requestAnimationFrame(()=>document.getElementById('pending-tray')?.focus({preventScroll:true}));
  };
  const selectAgent=(agentId:string)=>{locateRequest.current++;locateAfterLoad.current=null;setAround(undefined);setSelectedAgent(agentId);setSidebarCards(emptySidebarCards)};
  function revealCard(card: "context") {
    if(panelOverlay&&trayOpen)changeTray(false);
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
        openFile:setFile,openAgent:readAgent,
        run: run ?? null,
        runMessageId,
        arrivals:arrivals.current,
      }}
    >
      <WorkflowProvider value={{L,blocks,readonly,actor:id=>participants.find(p=>p.id===id)?.label??id,tools:calls=><ToolCalls calls={calls} workers={workers}/>,
        decide:async(messageId,answer)=>{try{await api('/conversations/'+id+'/decisions',{messageId,answer,locale:lang})}finally{await refresh()}},
        answerWorker:body=>api('/conversations/'+id+'/decisions',body),refresh,
        readDraft:(messageId)=>api('/conversations/'+id+'/file-reviews?message='+encodeURIComponent(messageId)),
        reviewFile:async(messageId,state)=>{try{await api('/conversations/'+id+'/file-reviews',{messageId,state})}finally{await refresh()}},
        authorize:async(request,value)=>{try{await api('/conversations/'+id+'/approvals',{id:request,value})}finally{await refresh()}}
      }}><AssistantRuntimeProvider runtime={runtime}>
        <InteractionProvider L={L} messages={snapshot?.messages??[]} reply={quoteMessage} react={reactMessage} locate={messageId=>void locateMessage(messageId)}>
        <div
          className={
            "chat-shell studio-shell" +
            (menu ? " menu-open" : "") +
            (panel ? " team-open" : "") +
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
            {configuring ? <header className="chat-header">
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
              <div className="studio-breadcrumb">
                <span>{L("Settings","设置")}</span><ChevronRight size={14}/>{workspacePage && <><a href="/configure#workspace">{L("Workspace settings","工作区设置")}</a><ChevronRight size={14}/></>}<strong>{pageTitle}</strong>
              </div>
            </header> : <>
              <div className="chat-float chat-float-start roppo-ui">
                <a href="/configure#general" className="icon-button" aria-label={L("Settings","设置")} title={L("Settings","设置")}><Settings size={19}/></a>
                {display === "agents" && <ChatMemberPicker L={L} participants={participants} selected={selected.id} select={readAgent}/>}
              </div>
              <div className="chat-float chat-float-center">
                <ChatCompanion status={companionStatus(snapshot,L,{participantId:readonly?selected.id:undefined,connected,sending,loading})} L={L}
                  onOpen={()=>{setTeamTab("activity");void choosePanel("activity")}}/>
              </div>
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
            </>}
            <SwitchView scope="page"><div className="workspace-page-stage" data-route={route}>
            {workspaceIndex && <WorkspaceSettings L={L}/>}
            {teamSettings?<TeamSettings L={L} members={participants.map(member=>({...member,model:member.kind==='router'?ready?.model:workers.find(w=>w.id===member.id)?.model}))}/>:null}
            {general?<General onDisplayChange={p.setDisplay} openWorkspaces={()=>{history.pushState(null,"","/configure#advanced/host");window.dispatchEvent(new Event("roppo:navigation"));setPickerRequest(v=>v+1)}} dark={dark} setDark={setDark} lang={lang} setLang={setLang} display={display} L={L}/>:null}
            {marketRoute?<Suspense fallback={<div className="workspace-view-placeholder" role="status">{L("Loading plugins…","正在加载插件…")}</div>}><PluginMarketplace route={hash} language={lang}/></Suspense>:null}
            {automationRoute?<Suspense fallback={<div className="workspace-view-placeholder" role="status">{L("Loading automations…","正在加载自动化…")}</div>}><AutomationWorkspace language={lang}/></Suspense>:null}
            <Configuration
              visible={configuring&&!general&&!workspaceIndex&&!teamSettings&&!automationRoute&&!pluginId&&(!marketRoute||marketTools)}
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
              {trayVisible&&<PendingTray cards={pendingCards} loading={!snapshot&&loading} close={closeTray} locate={card=>{
                changeTray(false);
                if(panel)void choosePanel(null);
                if('messageId' in card)void locateMessage(card.messageId,card.id);
                else void locateMessage(card.id);
              }}/>}
              <ThreadPrimitive.Root
                ref={threadRef}
                className="thread"
                data-welcome={!readonly && !loading && !snapshot?.messages.length && !sending && !running || undefined}
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
                        {readonly?<AgentAvatar id={selected.id} kind="worker" size={64}/>:null}
                        <h1>
                          {readonly ? L("No collaboration messages yet", "暂无协作消息") : L("What shall we work on?", "今天想做什么？")}
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
                        "Reconnecting… Your work continues.",
                        "正在重连，任务仍在继续。",
                      )}
                    </div>
                  ) : null}
                  <Readiness ready={ready} />
                  {readonly ? <div className="composer worker-readonly"><textarea disabled rows={1} aria-label={L("Message "+currentRouter.label+" to continue", "请与 "+currentRouter.label+" 对话")} placeholder={L("Message "+currentRouter.label+" to continue", "请与 "+currentRouter.label+" 对话")}/><button onClick={()=>selectAgent(currentRouter.id)}>{L("Message "+currentRouter.label, "前往 "+currentRouter.label)}</button></div> : <ComposerPrimitive.AttachmentDropzone asChild disabled={sending||loadingAttachments||!ready?.ready}><ComposerPrimitive.Root className="composer">
                    <QuotePreview quote={quote} L={L} onClear={()=>saveQuote(null)}/>
                    <div className="composer-attachments"><ComposerPrimitive.Attachments components={{Attachment:ComposerAttachment}}/></div>
                    <ComposerControls visible={!configuring} L={L} sending={sending} router={currentRouter.label}
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
                {!readonly && !loading && !snapshot?.messages.length && !sending && !running ? <div className="starter-actions">
                  {[
                    {Icon:ListChecks,label:L("Make a checklist","整理清单"),text:L("Prepare a launch checklist grouped by owner.","把发布前的检查项按负责人整理成一份清单。")},
                    {Icon:UsersRound,label:L("Meet the team","查看分工"),text:L("Which Agents are in this workspace and what can they do?","我的团队里有哪些 Agent？各自负责什么？")},
                    {Icon:FileText,label:L("Draft a brief","起草简报"),text:L("Draft a short progress brief for this release.","帮我起草一份发布进度简报。")}
                  ].map(({Icon,label,text})=><button key={label} onClick={()=>{runtime.thread.composer.setText(text);threadRef.current?.querySelector<HTMLTextAreaElement>('.composer-input')?.focus()}}><Icon size={16}/>{label}</button>)}
                </div>:null}
              </ThreadPrimitive.Root>
              {panel && <aside id="session-panel" aria-label={L('Session panel', '会话面板')}
                className={'session-panel '+(overview ? 'chat-inspector team-drawer' : 'resource-workspace'+(panelExpanded?' expanded':''))}>
                <SidebarSeparator pane="panel" controls="session-panel" label={L("Session panel","会话面板")}/>
                {overview && <TeamOverview snapshot={snapshot} participants={participants} routerLabel={currentRouter.label} lang={lang} L={L}
                  tab={sidebarCards.revealing ? 'activity' : teamTab} focusOnOpen={!sidebarCards.revealing}
                  setTab={tab => {
                    if (sidebarCards.revealing && tab !== 'activity') void choosePanel('activity');
                    setTeamTab(tab);
                  }}
                  close={closePanel} select={readAgent} openFile={setFile} resource={kind=>void choosePanel(kind)}
                  cards={!configuring && !readonly && sidebarCards.items.length > 0 && sidebarCards.items.map(card =>
                    card === 'context' && <ContextCard key={JSON.stringify([card, id, current?.backend, current?.model])}
                      current={usage} L={L} focusOnReveal={panelOverlay && sidebarCards.revealing}
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
                    <FilesPanel conversationId={id} deliveries={snapshot?.deliveries ?? []} openFile={setFile} L={L} />
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
