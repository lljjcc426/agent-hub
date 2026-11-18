import { DisclosureRoot, DisclosureSummary } from '../ui/overlays.tsx'
import { InputControl, SelectField } from '../ui/controls.tsx'
import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  Globe,
  Plus,
  X,
  ArrowLeft,
  ArrowRight,
  RotateCw,
  KeyRound,
  Settings2,
  Hand,
  Play,
  LoaderCircle,
  Trash2,
  Save,
  Power,
} from "lucide-react";
import type { BrowserManager } from "../../src/browser-manager.ts";
import type { BrowserAction } from "../../src/browser-contract.ts";
import {BrowserViewport} from './browser-viewport.tsx';
import {BrowserFiles} from './browser-files.tsx';
import {resourceUrl} from './resource-state.ts';
import type {BrowserInput} from '../../src/browser-input.ts';
import "./browser.css";

type State = ReturnType<BrowserManager["list"]>;
type Session = State["sessions"][number];
type L = (en: string, zh: string) => string;
// Stable while moving between conversations or reopening the panel; unique per document/window.
const browserClient = crypto.randomUUID();
async function request<T>(path: string, body?: unknown): Promise<T> {
  const r = await fetch("/api/browser" + path, {
    credentials: "same-origin",
    ...(body === undefined
      ? {}
      : {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        }),
  });
  const data = await r.json();
  if (!r.ok) throw Error(data.code ?? "network_error");
  return data;
}
const messages: Record<string, [string, string]> = {
  browser_tab_limit: ["This browser has reached its tab limit.", "浏览器标签页数量已达上限。"],
  browser_tab_missing: ["This page has already closed.", "此网页已经关闭。"],
  browser_workspace_offline: ["Connecting to workspace Chromium…","正在连接工作区 Chromium…"],
  browser_profile_in_use: ["This browser is open in another conversation. Create another browser, or close it there first.","此浏览器正在另一会话中使用。请创建另一个浏览器，或先在原会话中关闭。"],
  browser_control_busy: [
    "Another window controls this browser.",
    "另一个窗口正在控制此浏览器。",
  ],
  browser_control_required: ["Take control to interact.", "请先接管浏览器。"],
  browser_control_changed: [
    "Control changed. Refresh and try again.",
    "控制权已变更，请刷新后重试。",
  ],
  browser_stale_snapshot: [
    "The page changed. Refresh before continuing.",
    "页面已变化，请刷新后继续。",
  ],
  browser_command_failed: [
    "The browser action failed. Inspect the page before retrying.",
    "浏览器操作失败，请检查页面后再重试。",
  ],
  browser_uncertain: [
    "The result is uncertain. Check the page before repeating this action.",
    "操作结果未确认，请检查页面，避免重复提交。",
  ],
  browser_unavailable: [
    "Browser engine unavailable. Check the host installation.",
    "浏览器引擎不可用，请检查宿主安装。",
  ],
  browser_login_form: [
    "Could not identify the sign-in form. You can sign in manually.",
    "未能识别登录表单，可以手动登录。",
  ],
  browser_disabled: ["Browser access is disabled.", "浏览器访问已关闭。"],
  browser_capacity: [
    "Close an idle browser to continue.",
    "请关闭闲置浏览器后再继续。",
  ],
  browser_stream: ["Browser disconnected. Reconnect to continue.","浏览器已断开，请重新连接。"],
  attachment_too_large: ["File exceeds 25 MB.","文件超过 25 MB。"],
  browser_assignment_ended: ["The task has ended. Open its retained browser to continue manually.","任务已结束，可接管保留的页面继续操作。"],
  browser_missing: ["This browser has closed.", "此浏览器已关闭。"],
  browser_key_invalid: [
    "Saved accounts could not be unlocked.",
    "无法解锁已保存的账号。",
  ],
  validation_error: ["Check the entered fields.", "请检查填写内容。"],
};

  const Button = ({
    label,
    children,
    onClick,
    disabled = false,
  }: {
    label: string;
    children: React.ReactNode;
    onClick: () => void;
    disabled?: boolean;
  }) => (
    <button
      className="icon-button"
      title={label}
      aria-label={label}
      type="button"
      disabled={disabled}
      onClick={onClick}
    >
      {children}
    </button>
  );

export type BrowserPages = {
  sessionId: string;
  tabs: Session['tabs'];
  canEdit: boolean;
  select: (id: string) => Promise<void>;
  close: (id: string) => Promise<void>;
  create: () => Promise<void>;
};

export type BrowserPanelProps = {
  L: L;
  conversationId?: string;
  requestedUrl?: string;
  onUrlConsumed?: () => void;
  requestedSession?: {id: string; takeover: boolean; key: number};
  settingsOnly?: boolean;
  visibility?: 'page' | 'tabs' | 'hidden';
  renderWorkspace?: (pages: BrowserPages | undefined, content: ReactNode) => ReactNode;
};

export function BrowserPanel({L, conversationId='', requestedUrl='', onUrlConsumed, requestedSession,
  settingsOnly=false, visibility='page', renderWorkspace}: BrowserPanelProps) {
  const workspaceVisible = visibility !== 'hidden';
  const client = browserClient;
  const [data, setData] = useState<State | null>(null),
    [selected, setSelected] = useState(()=>{try{return sessionStorage.getItem('roppo.browser.selected.'+conversationId)||''}catch{return ''}}),
    [connected, setConnected] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [address, setAddress] = useState(""),
    [dialog, setDialog] = useState<"profile" | "accounts" | null>(null);
  const [profileId, setProfileId] = useState(""),
    [profileName, setProfileName] = useState(""),
    [grants, setGrants] = useState<string[]>([]);
  const [accountId, setAccountId] = useState(""),
    [accountProfile, setAccountProfile] = useState(""),
    [label, setLabel] = useState(""),
    [loginUrl, setLoginUrl] = useState(""),
    [username, setUsername] = useState(""),
    [password, setPassword] = useState("");
  useEffect(()=>{if(selected)try{sessionStorage.setItem('roppo.browser.selected.'+conversationId,selected)}catch{}},[selected,conversationId]);
  const active = useRef(true),
    sessionRef = useRef<Session | undefined>(undefined),
    loading = useRef(false),
    viewportDrain = useRef<()=>Promise<unknown>>(async()=>{}),
    dialogRef = useRef<HTMLDialogElement>(null),
    triggerRef = useRef<HTMLElement | null>(null);
  const session = data?.sessions.find((s) => s.id === selected),
    controlled = !!session?.controlledByYou && connected;
  sessionRef.current = session;
  const fail = (e: unknown) => {
    if (active.current)
      setError(e instanceof Error ? e.message : "network_error");
  };
  const refresh = async () => {
    if (loading.current) return;
    loading.current = true;
    try {
      const next = await request<State>("?client=" + client + (conversationId ? "&conversation=" + conversationId : ""));
      if (active.current) {
        setData(next);
        if (next.sessions.some(s=>s.workspace))
          setError(previous=>["browser_workspace_offline","browser_missing"].includes(previous) ? "" : previous);
      }
    } catch (e) {
      fail(e);
    } finally {
      loading.current = false;
    }
  };
  const update = (value: Session) => {
    if (active.current)
      setData((old) =>
        old
          ? {
              ...old,
              sessions: old.sessions.some((s) => s.id === value.id)
                ? old.sessions.map((s) => (s.id === value.id ? value : s))
                : [...old.sessions, value],
            }
          : old,
      );
  };
  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError("");
    try {
      await fn();
      await refresh();
    } catch (e) {
      fail(e);
    } finally {
      if (active.current) setBusy(false);
    }
  };
  useEffect(() => {
    active.current = true;
    if (workspaceVisible) void refresh();
    const timer = workspaceVisible ? setInterval(() => void refresh(), 2000) : undefined;
    return () => {
      active.current = false;
      clearInterval(timer);
    };
  }, [workspaceVisible]);
  useEffect(() => {
    if (data && !data.sessions.some((s) => s.id === selected))
      setSelected(data.sessions[0]?.id ?? "");
  }, [data, selected]);
  useEffect(() => {
    setAddress(session?.url === "about:blank" ? "" : (session?.url ?? ""));
  }, [session?.url, selected]);
  useEffect(() => {
    setConnected(false);
    if (!workspaceVisible || !selected || settingsOnly) return;
    let current=true;
    let inspecting = false;
    const inspect = async () => {
      if (inspecting) return;
      inspecting = true;
      try {
        {
          const value = await request<Session>(
            "/sessions/" + selected + "?client=" + client,
          );
          if (current) update(value);
        }
      } catch (e) {
        fail(e);
      } finally {
        inspecting = false;
      }
    };
    void inspect();
    const timer = setInterval(() => void inspect(), 5000);
    return () => {
      current = false;
      clearInterval(timer);
    };
  }, [selected, settingsOnly, workspaceVisible]);
  useEffect(() => {
    if (visibility !== 'page' || !session?.controlledByYou) return;
    const timer = setInterval(
      () =>
        void request<Session>("/sessions/" + session.id + "/renew", {
          client,
          epoch: session.epoch,
        })
          .then(update)
          .catch(fail),
      20000,
    );
    return () => clearInterval(timer);
  }, [visibility, session?.id, session?.epoch, session?.controlledByYou]);
  useEffect(() => {
    if (!dialog) return;
    triggerRef.current = document.activeElement as HTMLElement;
    dialogRef.current?.showModal();
    return () => triggerRef.current?.focus();
  }, [dialog]);
  const operation = (operation: Partial<BrowserAction>) =>
    act(async () => {
      const s = sessionRef.current;
      if (!s) return;
      await viewportDrain.current();
      if (s.id !== sessionRef.current?.id || s.epoch !== sessionRef.current.epoch)
        throw Error('browser_control_changed');
      update(
        await request<Session>("/sessions/" + s.id + "/action", {
          client,
          epoch: s.epoch,
          operation: {
            ...operation,
            ...(["click", "fill", "press"].includes(operation.action ?? "")
              ? { revision: s.revision }
              : {}),
          },
        }),
      );
    });
  const handledUrl=useRef('');
  useEffect(()=>{
    if(!requestedUrl){handledUrl.current='';return;}
    if(busy||!data||handledUrl.current===requestedUrl)return;
    handledUrl.current=requestedUrl;
    void act(async()=>{
      await viewportDrain.current();
      const value=session?.personal&&controlled?session:await request<Session>('/open',{client,conversationId});
      update(value);setSelected(value.id);
      update(await request<Session>('/sessions/'+value.id+'/action',{client,epoch:value.epoch,operation:{action:'new_tab',url:requestedUrl}}));
      onUrlConsumed?.();
    });
  },[requestedUrl,data,busy]);
  const input = (event: BrowserInput) => {
    const captured=session;
    if(!captured?.controlledByYou)return Promise.resolve();
    return request('/sessions/'+captured.id+'/input',{client,epoch:captured.epoch,event});
  };
  const openDefault=()=>act(async()=>{
    await viewportDrain.current();
    const value=await request<Session>('/open',{client,conversationId});update(value);setSelected(value.id);
  });
  const handledSession=useRef(0);
  useEffect(()=>{
    if(busy||!requestedSession||!data?.sessions.some(s=>s.id===requestedSession.id)||handledSession.current===requestedSession.key)return;
    handledSession.current=requestedSession.key;
    void act(async()=>{
      await viewportDrain.current();
      setSelected(requestedSession.id);
      if(requestedSession.takeover)update(await request<Session>('/sessions/'+requestedSession.id+'/takeover',{client}));
    });
  },[requestedSession,data,busy]);

  const newProfile = () => {
    setProfileId("");
    setProfileName(L("Personal browser", "个人浏览器"));
    setGrants([]);
    setDialog("profile");
  };
  const accounts = () => {
    setAccountId("");
    setAccountProfile(session?.profileId ?? data?.profiles[0]?.id ?? "");
    setLabel("");
    setLoginUrl(session?.url === "about:blank" ? "" : (session?.url ?? ""));
    setUsername("");
    setPassword("");
    setDialog("accounts");
  };
  const closeDialog = () => {
    setPassword("");
    setDialog(null);
  };
  const labelFor = (s: Session) =>
    s.workspace ? L('Workspace browser','工作区浏览器') : s.personal
      ? (data?.profiles.find((p) => p.id === s.profileId)?.name ??
        L("My browser", "我的浏览器"))
      : (data?.workers.find((w) => w.id === s.workerId)?.label ?? "Worker") +
        " · " +
        (s.title || L("Browser", "浏览器"));
  const pages: BrowserPages | undefined = session && {
    sessionId: session.id,
    tabs: session.tabs,
    canEdit: !!session.controlledByYou && !busy,
    select: tab => operation({action: 'select_tab', tab}),
    close: tab => operation({action: 'close_tab', tab}),
    create: () => operation({action: 'new_tab', url: 'about:blank'}),
  };
  const content = (
    <aside
      className={'browser-panel'+(settingsOnly?' browser-settings':'')} aria-label={L("Browser", "浏览器")} id="browser-panel">
      {settingsOnly && <div className="browser-select">
        <h2>{L('Saved browsers','已保存的浏览器')}</h2>
        <Button label={L('New browser','新建浏览器')} onClick={newProfile} disabled={busy}><Plus size={17}/></Button>
        <Button label={L('Saved accounts','已保存账号')} onClick={accounts} disabled={!data?.profiles.length}><KeyRound size={17}/></Button>
      </div>}
      {settingsOnly?<div className="browser-profile-list">{data?.profiles.length===0 && <div className="settings-empty"><Globe size={24}/><span>{L('No browsers yet','还没有浏览器')}</span></div>}{data?.profiles.map(p=><button key={p.id} onClick={()=>{setProfileId(p.id);setProfileName(p.name);setGrants(p.allowedWorkers);setDialog('profile')}}><Globe size={18}/><span>{p.name}</span><Settings2 size={16}/></button>)}</div>:null}
      {error && !dialog && (
        <div className="browser-error" role="alert">
          <span>
            {messages[error]
              ? L(...messages[error]!)
              : L("Unable to complete this operation.", "未能完成此操作。")}
          </span>
          <Button
            label={L("Dismiss error", "关闭提示")}
            onClick={() => setError("")}
          >
            <X size={14} />
          </Button>
        </div>
      )}
      {!settingsOnly && (session ? (
        <>
          <form
            className="browser-address"
            onSubmit={(e) => {
              e.preventDefault();
              if (address.trim())
                void operation({
                  action: "navigate",
                  url: resourceUrl(address) ?? "https://www.google.com/search?q=" + encodeURIComponent(address.trim()),
                });
            }}
          >
            <Button
              label={L("Back", "后退")}
              onClick={() => void operation({ action: "back" })}
              disabled={!controlled || busy}
            >
              <ArrowLeft size={15} />
            </Button>
            <Button
              label={L("Forward", "前进")}
              onClick={() => void operation({ action: "forward" })}
              disabled={!controlled || busy}
            >
              <ArrowRight size={15} />
            </Button>
            <Button
              label={L("Reload", "重新加载")}
              onClick={() => void operation({ action: "reload" })}
              disabled={!controlled || busy}
            >
              <RotateCw size={15} />
            </Button>
            <InputControl
              aria-label={L("Website address", "网站地址")}
              placeholder={L("Enter a website", "输入网址")}
              value={address}
              onChange={(e) => setAddress(e.target.value)}
              disabled={!controlled || busy}
            />
            {!session.workspace && <Button
              label={L("Close this browser", "关闭此浏览器")}
              onClick={() =>
                void act(async () => {
                  await request("/sessions/" + session.id + "/close", {
                    client,
                    epoch: session.epoch,
                  });
                  setSelected("");
                })
              }
              disabled={
                busy ||
                (session.control === "human" && !session.controlledByYou)
              }
            >
              <Power size={15} />
            </Button>}
          </form>
          <BrowserViewport key={session.id} id={session.id} epoch={session.epoch} controlled={!!session.controlledByYou} accepting={!busy} input={input} drainRef={viewportDrain}
            selection={()=>request<{text:string}>('/sessions/'+session.id+'/selection',{client,epoch:session.epoch})}
            onConnected={setConnected} onError={fail} L={L}/>
          <footer className="browser-control">
            <SelectField aria-label={L('Browser session','浏览器会话')} value={selected} disabled={busy} onChange={e=>{
              const id=e.target.value;
              void act(async()=>{
                await viewportDrain.current();
                if(id.startsWith('profile:')){
                  const value=await request<Session>('/profiles/'+id.slice(8)+'/open',{client,conversationId});
                  update(value);setSelected(value.id);
                }else setSelected(id);
              });
            }}>
              {data?.sessions.map(s=><option key={s.id} value={s.id}>{labelFor(s)}</option>)}
              {data?.profiles.filter(p=>!data.sessions.some(s=>s.personal&&s.profileId===p.id)).map(p=><option key={p.id} value={'profile:'+p.id}>{p.name}</option>)}
            </SelectField>
            <Button label={data?.workspace ? L('Workspace browser','工作区浏览器') : L('Personal browser','个人浏览器')} onClick={()=>void openDefault()} disabled={busy}><Globe size={16}/></Button>
            <a className="icon-button" href="/configure#advanced/browser" aria-label={L('Browser settings','浏览器设置')} title={L('Browser settings','浏览器设置')}><Settings2 size={16}/></a>
            {!session.workspace && <BrowserFiles key={session.id} id={session.id} client={client} epoch={session.epoch} controlled={controlled} L={L} onError={fail} onUploaded={()=>void refresh()}/>}
            {controlled&&data?.credentials.some(a=>a.profileId===session.profileId)?<DisclosureRoot className="browser-logins"><DisclosureSummary className="icon-button" aria-label={L('Saved sign-ins','已保存登录')} title={L('Saved sign-ins','已保存登录')}><KeyRound size={16}/></DisclosureSummary><div>{data.credentials.filter(a=>a.profileId===session.profileId).map(a=><button key={a.id} onClick={e=>{e.currentTarget.closest('details')!.open=false;void operation({action:'login',credentialId:a.id})}}>{a.label}</button>)}</div></DisclosureRoot>:null}
            <span>
              {busy ? (
                <LoaderCircle size={14} className="spin" />
              ) : (
                <span
                  className={
                    "browser-status-dot" + (connected ? " connected" : "")
                  }
                />
              )}{" "}
              {session.controlledByYou
                ? L("You have control", "由你控制")
                : session.control === "router" ? L("Router has control","由 Router 控制") : session.control === "worker"
                  ? L("Worker has control", "由 Worker 控制")
                  : session.control === "handoff"
                    ? L("Handing over…", "正在交接…")
                    : session.ended
                      ? L("Task ended", "任务已结束")
                      : L("Waiting for takeover", "等待接管")}
            </span>
            {session.controlledByYou ? (
              <button
                className="browser-primary"
                disabled={busy}
                onClick={() =>
                  void act(async () => {
                    await viewportDrain.current();
                    update(
                      await request<Session>(
                        "/sessions/" + session.id + "/release",
                        { client, epoch: session.epoch },
                      ),
                    );
                  })
                }
              >
                <Play size={14} />
                {session.workspace ? L("Return to Router","交还 Router") : session.personal || session.ended
                  ? L("Release control", "结束操作")
                  : L("Continue task", "继续任务")}
              </button>
            ) : (
              <button
                className="browser-primary"
                disabled={busy || session.control === "handoff"}
                onClick={() =>
                  void act(async () =>
                    update(
                      await request<Session>(
                        "/sessions/" + session.id + "/takeover",
                        { client, force: session.control === "human" },
                      ),
                    ),
                  )
                }
              >
                <Hand size={14} />
                {session.control === "human"
                  ? L("Take over here", "转移控制到此窗口")
                  : L("Take control", "接管")}
              </button>
            )}
          </footer>
        </>
      ) : (
        <div className="browser-empty">
          <Globe size={34} />
          <h2>{L("Browser", "浏览器")}</h2>
          <button
            className="browser-primary"
            disabled={busy || data?.enabled === false}
            onClick={()=>void openDefault()}
          >
            <Plus size={16} />
            {data?.workspace ? L("Open workspace browser","打开工作区浏览器") : L("Open browser", "打开浏览器")}
          </button>
          {!data && <LoaderCircle size={18} className="spin" />}
        </div>
      ))}
      {dialog && (
        <dialog
          ref={dialogRef}
          className="browser-dialog"
          onCancel={closeDialog}
          onKeyDown={e=>e.stopPropagation()}
          aria-labelledby="browser-dialog-title"
        >
          <header>
            <h2 id="browser-dialog-title">
              {dialog === "profile"
                ? L("Browser profile", "浏览器资料")
                : L("Saved accounts", "已保存账号")}
            </h2>
            <Button label={L("Close", "关闭")} onClick={closeDialog}>
              <X size={18} />
            </Button>
          </header>
          {error && (
            <div className="browser-error" role="alert">
              {messages[error]
                ? L(...messages[error]!)
                : L("Unable to complete this operation.", "未能完成此操作。")}
            </div>
          )}
          {dialog === "profile" ? (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void act(async () => {
                  const p = await request<State["profiles"][number]>(
                    "/profiles" + (profileId ? "/" + profileId : ""),
                    { name: profileName, allowedWorkers: grants },
                  );
                  closeDialog();
                  if(settingsOnly){await refresh();return;}
                  const s = await request<Session>(
                    "/profiles/" + p.id + "/open",
                    { client,conversationId },
                  );
                  update(s);
                  setSelected(s.id);
                });
              }}
            >
              <label>
                {L("Name", "名称")}
                <InputControl
                  autoFocus
                  required
                  maxLength={80}
                  value={profileName}
                  onChange={(e) => setProfileName(e.target.value)}
                />
              </label>
              <fieldset>
                <legend>
                  {L(
                    "Workers allowed to use these sign-ins",
                    "可使用此浏览器登录信息的 Worker",
                  )}
                </legend>
                {data?.workers.map((w) => (
                  <label className="browser-grant" key={w.id}>
                    <InputControl
                      type="checkbox"
                      checked={grants.includes(w.id)}
                      onChange={(e) =>
                        setGrants(
                          e.target.checked
                            ? [...grants, w.id]
                            : grants.filter((id) => id !== w.id),
                        )
                      }
                    />
                    {w.label}
                  </label>
                ))}
              </fieldset>
              <div className="browser-dialog-actions">
                <button type="button" onClick={closeDialog}>
                  {L("Cancel", "取消")}
                </button>
                <button className="browser-primary" disabled={busy}>
                  <Save size={14} />
                  {L("Save", "保存")}
                </button>
              </div>
            </form>
          ) : (
            <>
              <div className="browser-account-list">
                {data?.credentials.map((a) => (
                  <div key={a.id}>
                    <button
                      onClick={() => {
                        setAccountId(a.id);
                        setAccountProfile(a.profileId);
                        setLabel(a.label);
                        setLoginUrl(a.url);
                        setUsername(a.username);
                        setPassword("");
                      }}
                    >
                      <strong>{a.label}</strong>
                      <span>{a.username}</span>
                    </button>
                    {session?.profileId === a.profileId && (
                      <button
                        disabled={!controlled || busy}
                        onClick={() => {
                          closeDialog();
                          void operation({
                            action: "login",
                            credentialId: a.id,
                          });
                        }}
                      >
                        {L("Fill", "填入")}
                      </button>
                    )}
                    <Button
                      label={
                        L("Delete saved account", "删除已保存账号") +
                        " " +
                        a.label
                      }
                      disabled={busy}
                      onClick={() =>
                        void act(async () => {
                          await request("/accounts/" + a.id + "/remove", {});
                          if (accountId === a.id) {
                            setAccountId("");
                            setPassword("");
                          }
                        })
                      }
                    >
                      <Trash2 size={15} />
                    </Button>
                  </div>
                ))}
              </div>
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  void act(async () => {
                    await request(
                      "/accounts" + (accountId ? "/" + accountId : ""),
                      {
                        profileId: accountProfile,
                        label,
                        url: loginUrl,
                        username,
                        password,
                      },
                    );
                    setPassword("");
                    setAccountId("");
                    setLabel("");
                    setUsername("");
                  });
                }}
              >
                <label>
                  {L("Browser profile", "浏览器资料")}
                  <SelectField
                    required
                    value={accountProfile}
                    onChange={(e) => setAccountProfile(e.target.value)}
                  >
                    {data?.profiles.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}
                      </option>
                    ))}
                  </SelectField>
                </label>
                <label>
                  {L("Account name", "账号名称")}
                  <InputControl
                    required
                    maxLength={80}
                    value={label}
                    onChange={(e) => setLabel(e.target.value)}
                  />
                </label>
                <label>
                  {L("Sign-in URL", "登录网址")}
                  <InputControl
                    required
                    type="url"
                    value={loginUrl}
                    onChange={(e) => setLoginUrl(e.target.value)}
                  />
                </label>
                <label>
                  {L("Username", "用户名")}
                  <InputControl
                    required
                    autoComplete="off"
                    value={username}
                    onChange={(e) => setUsername(e.target.value)}
                  />
                </label>
                <label>
                  {accountId
                    ? L("New password", "新密码")
                    : L("Password", "密码")}
                  <InputControl
                    required
                    type="password"
                    autoComplete="new-password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                  />
                </label>
                <div className="browser-dialog-actions">
                  {accountId && (
                    <button
                      type="button"
                      onClick={() => {
                        setAccountId("");
                        setLabel("");
                        setUsername("");
                        setPassword("");
                      }}
                    >
                      {L("Add another", "添加其他账号")}
                    </button>
                  )}
                  <button className="browser-primary" disabled={busy}>
                    <Save size={14} />
                    {accountId
                      ? L("Update account", "更新账号")
                      : L("Save account", "保存账号")}
                  </button>
                </div>
              </form>
            </>
          )}
        </dialog>
      )}
    </aside>
  );
  return renderWorkspace ? renderWorkspace(pages, content) : content;
}
