import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { LoaderCircle, RefreshCw } from "lucide-react";
import type { BrowserInput } from "../../src/browser-input.ts";
import type { BrowserActivity, BrowserFrame } from "../../src/browser-contract.ts";
import { browserPoint } from "./browser-geometry.ts";
import { BrowserInputQueue } from "./browser-input-queue.ts";
import { BrowserAgentGlow, BrowserFeedback, useBrowserImageBounds } from "./browser-feedback.tsx";

type Props = {
  panelId: string;
  tabId?: string;
  pageId?: string;
  id: string;
  epoch: number;
  controlled: boolean;
  agentControlled: boolean;
  accepting: boolean;
  displayClient?:string;
  resize?: (width:number,height:number)=>Promise<unknown>;
  input: (event: BrowserInput) => Promise<unknown>;
  selection: () => Promise<{ text: string }>;
  drainRef: { current: () => Promise<unknown> };
  onConnected: (connected: boolean) => void;
  onError: (error: unknown) => void;
  L: (en: string, zh: string) => string;
};
export function BrowserViewport({
  panelId,
  tabId,
  pageId,
  id,
  epoch,
  controlled,
  agentControlled,
  accepting,
  displayClient,
  resize,
  input,
  selection,
  drainRef,
  onConnected,
  onError,
  L,
}: Props) {
  const image = useRef<HTMLImageElement>(null),
    viewport = useRef<HTMLDivElement>(null),
    keyboard = useRef<HTMLTextAreaElement>(null),
    frame = useRef<Pick<BrowserFrame,'width'|'height'|'tab'> | null>(null);
  const clicks = useRef({
    at: 0,
    x: 0,
    y: 0,
    count: 0,
    button: "none" as "none" | "left" | "right" | "middle",
  });
  const composing = useRef(false),
    pointer = useRef<{ x: number; y: number }>({ x: 0, y: 0 });
  const [queue] = useState(() => new BrowserInputQueue());
  const [activity,setActivity]=useState<BrowserActivity>()
  const [streamTab,setStreamTab]=useState<string>()
  const activityTimeout=useRef<ReturnType<typeof setTimeout>|undefined>(undefined)
  const owner=useRef({agentControlled,pageId})
  owner.current={agentControlled,pageId}
  const showActivity=useCallback((event:BrowserActivity)=>{
    setActivity(event)
    clearTimeout(activityTimeout.current)
    activityTimeout.current=setTimeout(()=>setActivity(undefined),1450)
  },[])
  const callbacks = useRef({ input, selection, resize,onConnected, onError });
  callbacks.current = { input, selection, resize,onConnected, onError };
  const canResize=!!resize;
  useEffect(()=>{
    const element=viewport.current;
    if(!element||!canResize)return;
    let live=true,pending=false,timer:ReturnType<typeof setTimeout>;
    let appliedWidth=0,appliedHeight=0;
    const fit=async()=>{
      if(!live||pending)return;
      const width=element.clientWidth,height=element.clientHeight;
      if(!width||!height||(width===appliedWidth&&height===appliedHeight))return;
      pending=true;
      try{
        await callbacks.current.resize?.(width,height);
        appliedWidth=width;appliedHeight=height;
      }catch(error){
        if(live&&!(error instanceof Error&&['browser_control_required','browser_control_changed','browser_missing'].includes(error.message)))
          callbacks.current.onError(error);
      }finally{
        pending=false;
        if(live&&(element.clientWidth!==width||element.clientHeight!==height))schedule();
      }
    };
    const schedule=()=>{clearTimeout(timer);timer=setTimeout(()=>void fit(),90)};
    const observer=new ResizeObserver(schedule);
    observer.observe(element);schedule();
    return ()=>{live=false;observer.disconnect();clearTimeout(timer)};
  },[id,epoch,pageId,canResize]);
  const [state, setState] = useState<
      "connecting" | "connected" | "disconnected"
    >("connecting"),
    [attempt, setAttempt] = useState(0);
  const pageBounds=useBrowserImageBounds(image,viewport,state==='connected')
  useEffect(() => {
    return () => queue.cancel();
  }, [queue]);
  useEffect(() => {
    queue.cancel();
  }, [id, epoch, controlled, queue]);
  useEffect(()=>{
    setActivity(undefined)
    return ()=>clearTimeout(activityTimeout.current)
  },[id,epoch,controlled])
  useEffect(() => {
    frame.current = null;
    setStreamTab(undefined)
    setActivity(undefined)
    setState("connecting");
    callbacks.current.onConnected(false);
    const source = new EventSource("/api/browser/sessions/" + id + "/stream"+(displayClient?'?client='+encodeURIComponent(displayClient):''));
    source.addEventListener("frame", (event) => {
      const f:BrowserFrame = JSON.parse((event as MessageEvent).data);
      frame.current = {width:f.width,height:f.height,tab:f.tab};
      if (image.current) {
        image.current.src = "data:image/jpeg;base64," + f.data;
        image.current.dataset.detail=f.detail?'true':'false'
      }
      setStreamTab(f.tab)
      setState("connected");
      callbacks.current.onConnected(true);
    });
    source.addEventListener('activity',event=>{
      if(!owner.current.agentControlled)return
      const next:BrowserActivity=JSON.parse((event as MessageEvent).data)
      if(next.tab===(frame.current?.tab??owner.current.pageId))showActivity(next)
    })
    source.addEventListener("status", (event) => {
      if (!JSON.parse((event as MessageEvent).data).connected) {
        setActivity(undefined)
        setState("disconnected");
        callbacks.current.onConnected(false);
      }
    });
    const disconnected = () => {
      setActivity(undefined)
      setState("disconnected");
      callbacks.current.onConnected(false);
    };
    source.addEventListener("closed", () => {
      source.close();
      disconnected();
    });
    source.onerror = disconnected;
    return () => source.close();
  }, [id, attempt,showActivity,displayClient]);
  const report = (error: unknown) => {
    if (!(error instanceof DOMException && error.name === "AbortError"))
      callbacks.current.onError(error);
  };
  drainRef.current = () => queue.drain();
  const send = (event: BrowserInput) => {
    if (!controlled || !accepting || state !== "connected") return;
    void queue.input(event, callbacks.current.input).catch(report);
  };
  const point = (x: number, y: number) => {
    const img = image.current,
      f = frame.current;
    return img && f
      ? browserPoint(
          { x, y },
          img.getBoundingClientRect(),
          { width: img.naturalWidth, height: img.naturalHeight },
          f.width,
        )
      : null;
  };
  const mouse = (event: ReactPointerEvent, phase: "down" | "move" | "up") => {
    if (!controlled || !accepting || state !== "connected") return;
    if (phase === "up" && !event.currentTarget.hasPointerCapture(event.pointerId)) return;
    const p =
      point(event.clientX, event.clientY) ??
      (phase === "up" ? pointer.current : null);
    if (!p) return;
    pointer.current = p;
    if (phase === "down") {
      event.preventDefault();
      keyboard.current?.focus({ preventScroll: true });
      event.currentTarget.setPointerCapture(event.pointerId);
    }
    const button =
      phase === "move"
        ? event.buttons & 1
          ? "left"
          : event.buttons & 2
            ? "right"
            : event.buttons & 4
              ? "middle"
              : "none"
        : ((["left", "middle", "right"] as const)[event.button] ?? "none");
    if (phase === "down") {
      const previous = clicks.current,
        at = Date.now();
      clicks.current = {
        at,
        ...p,
        button,
        count:
          at - previous.at < 500 &&
          Math.hypot(p.x - previous.x, p.y - previous.y) < 4 &&
          button === previous.button
            ? Math.min(3, previous.count + 1)
            : 1,
      };
      const current=frame.current, img=image.current, tab=current?.tab??pageId
      if(current&&img?.naturalWidth&&img.naturalHeight&&tab)
        showActivity({action:'click',tab,at,seq:at,point:{
          x:p.x/current.width,y:p.y*img.naturalWidth/(current.width*img.naturalHeight),
        }})
    }
    send({
      type: "pointer",
      phase,
      ...p,
      button: phase === "up" ? clicks.current.button : button,
      clickCount: phase === "move" ? 0 : clicks.current.count,
      modifiers:
        (event.altKey ? 1 : 0) |
        (event.ctrlKey ? 2 : 0) |
        (event.metaKey ? 4 : 0) |
        (event.shiftKey ? 8 : 0),
    });
  };
  const copy = async (cut: boolean) => {
    try {
      const { selection, input } = callbacks.current;
      const selected = queue.run(selection);
      void selected.catch(report);
      const text = selected.then(({ text }) => new Blob([text], { type: "text/plain" }));
      const written = navigator.clipboard.write([
        new ClipboardItem({ "text/plain": text }),
      ]);
      // The queue can be cancelled before this write's turn. Its rejection is
      // still reported by the queued operation when that operation runs.
      void written.catch(() => {});
      await queue.run(async () => {
        await written;
        if (cut && (await selected).text)
          await input({ type: "key", key: "Backspace", code: "Backspace" });
      });
    } catch (error) {
      report(error);
    }
  };
  useEffect(() => {
    const element = viewport.current;
    if (!element || !controlled || state !== "connected") return;
    const wheel = (event: WheelEvent) => {
      const p = point(event.clientX, event.clientY);
      if (!p) return;
      event.preventDefault();
      const unit =
        event.deltaMode === 1
          ? 16
          : event.deltaMode === 2
            ? element.clientHeight
            : 1;
      send({
        type: "wheel",
        ...p,
        deltaX: Math.max(-3000, Math.min(3000, event.deltaX * unit)),
        deltaY: Math.max(-3000, Math.min(3000, event.deltaY * unit)),
      });
    };
    element.addEventListener("wheel", wheel, { passive: false });
    return () => element.removeEventListener("wheel", wheel);
  }, [controlled, accepting, state, id, epoch]);
  const visibleActivity=state==='connected'&&(controlled||agentControlled)&&activity?.tab===(streamTab??pageId)
    ?activity:undefined
  return (
    <div
      ref={viewport}
      id={panelId}
      role={tabId ? "tabpanel" : undefined}
      aria-labelledby={tabId}
      className={"browser-viewport" + (controlled ? " controlled" : "")}
      onPointerDown={(e) => mouse(e, "down")}
      onPointerMove={(e) => mouse(e, "move")}
      onPointerUp={(e) => mouse(e, "up")}
      onPointerCancel={(e) => mouse(e, "up")}
      onContextMenu={(e) => e.preventDefault()}
    >
      <img
        ref={image}
        alt={L("Live browser page", "浏览器实时页面")}
        draggable={false}
        hidden={!frame.current}
      />
      <BrowserAgentGlow bounds={pageBounds} active={agentControlled&&accepting&&state==='connected'}/>
      <BrowserFeedback key={epoch+'-'+(streamTab??pageId??'')} activity={visibleActivity}
        controlled={controlled} bounds={pageBounds} L={L}/>
      {state === "connecting" ? (
        <div className="browser-loading" role="status">
          <LoaderCircle size={22} className="spin" />
          {L("Connecting…", "正在连接…")}
        </div>
      ) : null}
      {state === "disconnected" ? (
        <div className="browser-disconnected" role="status">
          <button onClick={() => setAttempt((a) => a + 1)}>
            <RefreshCw size={16} />
            {L("Reconnect", "重新连接")}
          </button>
        </div>
      ) : null}
      <textarea
        ref={keyboard}
        className="browser-keyboard"
        aria-label={L("Browser keyboard input", "浏览器键盘输入")}
        disabled={!controlled || !accepting}
        onCompositionStart={() => {
          composing.current = true;
        }}
        onCompositionEnd={(e) => {
          composing.current = false;
          if (e.currentTarget.value)
            send({ type: "text", text: e.currentTarget.value });
          e.currentTarget.value = "";
        }}
        onChange={(e) => {
          if (!composing.current && e.target.value) {
            send({ type: "text", text: e.target.value });
            e.target.value = "";
          }
        }}
        onPaste={(e) => {
          e.preventDefault();
          const text = e.clipboardData.getData("text/plain");
          if (text) send({ type: "text", text });
        }}
        onCopy={(e) => { e.preventDefault(); void copy(false); }}
        onCut={(e) => { e.preventDefault(); void copy(true); }}
        onKeyDown={(e) => {
          if (composing.current || e.nativeEvent.isComposing) return;
          if (e.key === "F6") {
            e.preventDefault();
            document
              .querySelector<HTMLInputElement>(".browser-address input")
              ?.focus();
            return;
          }
          const shortcut = (e.ctrlKey || e.metaKey) && !e.getModifierState('AltGraph'),
            key = e.key.toLowerCase();
          if (shortcut && (key === "c" || key === "x")) {
            e.preventDefault();
            void copy(key === "x");
            return;
          }
          if (shortcut && key === "v") return;
          if (
            (e.key.length > 1 &&
              !["Shift", "Control", "Meta", "Alt", "CapsLock"].includes(
                e.key,
              )) ||
            shortcut
          ) {
            e.preventDefault();
            e.stopPropagation();
            send({
              type: "key",
              key: e.key,
              code: e.code,
              modifiers:
                (e.altKey ? 1 : 0) |
                (e.ctrlKey ? 2 : 0) |
                (e.metaKey ? 4 : 0) |
                (e.shiftKey ? 8 : 0),
            });
          }
        }}
      />
    </div>
  );
}
