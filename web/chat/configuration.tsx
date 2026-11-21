import { lazy, Suspense, useEffect, useLayoutEffect, useRef, useState } from "react";
import {createPortal} from "react-dom";
import {BrowserPanel} from './browser.tsx';
import { IntakeEditor, SettingsFeedback, publishSettings, useSettingsEditor } from './settings-editor.tsx';
import {ChatSettings} from './chat-settings.tsx';
import {MemorySettings} from "./memory.tsx";
import {configuredReasoningEffort, reasoningOverride} from '../../src/agent-options.ts';
import type { mount } from "virtual:configuration-content";
const TeamConfiguration = lazy(async () => ({ default: (await import('./team-configuration.tsx')).TeamConfiguration }));
const RuntimeConfiguration = lazy(async () => ({ default: (await import('./runtime-configuration.tsx')).RuntimeConfiguration }));
const BrowserAgentAccess = lazy(async () => ({ default: (await import('./runtime-configuration.tsx')).BrowserAgentAccess }));
let controller: ReturnType<typeof mount> | undefined;
let element: HTMLDivElement | undefined;
let pending: Promise<void> | undefined;
let memoryElement: HTMLDivElement | undefined;
let browserElement: HTMLDivElement | undefined;
let chatElement: HTMLDivElement | undefined;
const active = () => {
  const { pathname, hash } = location;
  if (!["/configure", "/configure/", "/"].includes(pathname)) return false;
  if (["", "#general", "#appearance", "#workspace", "#automations", "#prompts/memory", "#tasks/statistics"].includes(hash)) return false;
  if (hash.startsWith("#plugin/")) return false;
  return !/^#integrations(?:\/|$)/.test(hash) || hash === "#integrations/tools";
};
async function prepare() {
  if (!pending)
    pending = import("virtual:configuration-content")
      .then((module) => {
        element = document.createElement("div");
        element.className = "management-content";
        memoryElement = document.createElement("div");
        chatElement = document.createElement("div");
        browserElement = document.createElement("div");
        controller = module.mount({
          element, active, settings: publishSettings,
          configuredReasoningEffort, reasoningOverride,
          memory: () => memoryElement!,
          chat: () => chatElement!,
          browser: () => browserElement!,
        });
      })
      .catch((error) => {
        pending = undefined;
        throw error;
      });
  await pending;
}
export function Configuration({
  visible,
  route,
  language,
  pickerRequest,
}: {
  visible: boolean;
  route: string;
  language: string;
  pickerRequest: number;
}) {
  const outlet = useRef<HTMLDivElement>(null),
    [error, setError] = useState(false),
    [browserTarget,setBrowserTarget]=useState<HTMLDivElement|null>(null),
    [chatTarget, setChatTarget] = useState<HTMLDivElement|null>(null),
    [memoryTarget, setMemoryTarget] = useState<HTMLDivElement|null>(null);
  const viewport = useRef<HTMLElement>(null);
  useLayoutEffect(() => {
    if (visible) viewport.current?.scrollTo(0, 0);
  }, [route, visible]);
  const pickerHandled = useRef(0);
  const latest = useRef({ visible, language });
  latest.current = { visible, language };
  useLayoutEffect(() => {
    if (!visible) {
      element
        ?.querySelectorAll<HTMLDialogElement>("dialog[open]")
        .forEach((dialog) => dialog.close());
      return;
    }
    let alive = true;
    const activate = () => {
        if (!alive) return;
        setError(false);
        if (element!.parentElement !== outlet.current) outlet.current?.append(element!);
        memoryElement!.classList.add("memory-mount");
        setMemoryTarget(memoryElement!);
        setChatTarget(chatElement!);
        setBrowserTarget(browserElement!);
        if (latest.current.visible) {
          controller!.activate(latest.current.language);
          if (pickerRequest > pickerHandled.current) {
            pickerHandled.current = pickerRequest;
            void controller!.workspace();
          }
        }
      };
    if (controller) activate();
    else void prepare().then(activate).catch(() => {
        if (alive) setError(true);
      });
    return () => {
      alive = false;
    };
  }, [visible, route, pickerRequest]);
  useEffect(() => {
    controller?.language(language);
  }, [language]);
  const hash = route.split("#")[1] ?? "";
  const intake = visible && hash === "advanced/intake";
  const team = visible && /^(?:team|execution\/configuration)(?:\/([a-z][a-z0-9_-]*))?$/.exec(hash);
  const running = visible && hash === "advanced/configuration";
  const editor = useSettingsEditor();
  const settings = editor?.structured;
  const L = (en: string, zh: string) => language === 'en' ? en : zh;
  return (
    <>
      <section
        ref={viewport}
        className="configuration-outlet"
        hidden={!visible}
        data-intake={intake || undefined}
        data-structured={!!(team || running) || undefined}
        aria-label={language === "en" ? "Workspace content" : "工作区内容"}
      >
        <div>
          <div ref={outlet} />
          {intake && <IntakeEditor language={language} />}
          {(team || running) && settings && (
            <Suspense fallback={<p className="workspace-view-placeholder" role="status">{L('Loading settings…', '正在读取设置…')}</p>}>
              {team ? <TeamConfiguration key={settings.scope + ':' + (team[1] ?? '')} settings={settings}
                memberId={team[1]} blocked={!!editor.blocked} hasDraft={!!editor.draft} L={L} />
                : <RuntimeConfiguration key={settings.scope} settings={settings} blocked={!!editor.blocked} L={L} />}
            </Suspense>
          )}
        </div>
        {visible && route.split("#")[1] === "advanced/memory" && memoryTarget ? createPortal(<MemorySettings L={(en, zh) => language === "en" ? en : zh}/>, memoryTarget) : null}
        {visible && route.split("#")[1] === "advanced/chat" && chatTarget ? createPortal(<ChatSettings L={(en, zh) => language === "en" ? en : zh}/>, chatTarget) : null}
        {visible && hash === "advanced/browser" && browserTarget ? createPortal(<>
          <BrowserPanel settingsOnly profileDialogTarget={viewport.current} L={L}/>
          {settings && <Suspense fallback={null}><BrowserAgentAccess settings={settings} blocked={!!editor.blocked} L={L} /></Suspense>}
        </>, browserTarget) : null}
        {error ? (
          <button
            className="configuration-retry"
            onClick={() => location.reload()}
          >
            {language === "en"
              ? "Couldn’t load this page. Reload"
              : "页面加载失败，重新加载"}
          </button>
        ) : null}
      </section>
      {visible && !error && <SettingsFeedback language={language} />}
    </>
  );
}
