import {
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { LoaderCircle, RefreshCw } from "lucide-react";
import type { BrowserInput } from "../../src/browser-input.ts";
import { browserPoint } from "./browser-geometry.ts";
import { BrowserInputQueue } from "./browser-input-queue.ts";

type Props = {
  id: string;
  epoch: number;
  controlled: boolean;
  accepting: boolean;
  input: (event: BrowserInput) => Promise<unknown>;
  resize: (width: number, height: number) => Promise<unknown>;
  selection: () => Promise<{ text: string }>;
  drainRef: { current: () => Promise<unknown> };
  onConnected: (connected: boolean) => void;
  onError: (error: unknown) => void;
  L: (en: string, zh: string) => string;
};
export function BrowserViewport({
  id,
  epoch,
  controlled,
  accepting,
  input,
  resize,
  selection,
  drainRef,
  onConnected,
  onError,
  L,
}: Props) {
  const image = useRef<HTMLImageElement>(null),
    viewport = useRef<HTMLDivElement>(null),
    keyboard = useRef<HTMLTextAreaElement>(null),
    frame = useRef<{ width: number; height: number } | null>(null);
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
  const callbacks = useRef({ input, resize, selection, onConnected, onError });
  callbacks.current = { input, resize, selection, onConnected, onError };
  const [state, setState] = useState<
      "connecting" | "connected" | "disconnected"
    >("connecting"),
    [attempt, setAttempt] = useState(0);
  useEffect(() => {
    return () => queue.cancel();
  }, [queue]);
  useEffect(() => {
    queue.cancel();
  }, [id, epoch, controlled, queue]);
  useEffect(() => {
    frame.current = null;
    setState("connecting");
    callbacks.current.onConnected(false);
    const source = new EventSource("/api/browser/sessions/" + id + "/stream");
    source.addEventListener("frame", (event) => {
      const f = JSON.parse((event as MessageEvent).data);
      frame.current = f;
      if (image.current) image.current.src = "data:image/jpeg;base64," + f.data;
      setState("connected");
      callbacks.current.onConnected(true);
    });
    source.addEventListener("status", (event) => {
      if (!JSON.parse((event as MessageEvent).data).connected) {
        setState("disconnected");
        callbacks.current.onConnected(false);
      }
    });
    const disconnected = () => {
      setState("disconnected");
      callbacks.current.onConnected(false);
    };
    source.addEventListener("closed", () => {
      source.close();
      disconnected();
    });
    source.onerror = disconnected;
    return () => source.close();
  }, [id, attempt]);
  useEffect(() => {
    if (!controlled || state !== "connected" || !viewport.current) return;
    let timer: ReturnType<typeof setTimeout>,
      last = "";
    const observer = new ResizeObserver(([entry]) => {
      const width = Math.max(320, Math.round(entry!.contentRect.width)),
        height = Math.max(200, Math.round(entry!.contentRect.height)),
        key = width + ":" + height;
      clearTimeout(timer);
      if (key !== last)
        timer = setTimeout(() => {
          last = key;
          void callbacks.current
            .resize(width, height)
            .catch(callbacks.current.onError);
        }, 180);
    });
    observer.observe(viewport.current);
    return () => {
      clearTimeout(timer);
      observer.disconnect();
    };
  }, [controlled, state, id, epoch]);
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
    if (!controlled) return;
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
  return (
    <div
      ref={viewport}
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
