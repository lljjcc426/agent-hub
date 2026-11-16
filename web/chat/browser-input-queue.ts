import type { BrowserInput } from "../../src/browser-input.ts";

type Entry = {
  event?: BrowserInput;
  result: Promise<unknown>;
  run: () => Promise<void>;
  cancel: (error: unknown) => void;
};

/** Clipboard reads and writes occupy the same order as pointer and keyboard input. */
export class BrowserInputQueue {
  private pending: Entry[] = [];
  private running: Promise<void> | null = null;

  input(event: BrowserInput, input: (event: BrowserInput) => Promise<unknown>) {
    const last = this.pending.at(-1), previous = last?.event;
    if (event.type === "pointer" && event.phase === "move" && previous?.type === "pointer" && previous.phase === "move") {
      Object.assign(previous, event);
      return last!.result;
    }
    if (event.type === "wheel" && previous?.type === "wheel") {
      previous.deltaX = Math.max(-3000, Math.min(3000, previous.deltaX + event.deltaX));
      previous.deltaY = Math.max(-3000, Math.min(3000, previous.deltaY + event.deltaY));
      previous.x = event.x;
      previous.y = event.y;
      return last!.result;
    }
    return this.run(() => input(event), event);
  }

  run<T>(action: () => Promise<T>, event?: BrowserInput): Promise<T> {
    let resolve!: (value: T) => void, reject!: (error: unknown) => void;
    const result = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
    this.pending.push({
      event, result, cancel: reject,
      run: async () => {
        try { resolve(await action()); }
        catch (error) { reject(error); throw error; }
      },
    });
    void this.drain().catch(() => {});
    return result;
  }

  cancel() {
    const error = new DOMException("Browser control changed", "AbortError");
    for (const entry of this.pending.splice(0)) entry.cancel(error);
  }

  drain(): Promise<void> {
    if (this.running) return this.running;
    if (!this.pending.length) return Promise.resolve();
    this.running = (async () => {
      try {
        while (this.pending.length) await this.pending.shift()!.run();
      } catch (error) {
        this.cancel();
        throw error;
      } finally {
        this.running = null;
      }
    })();
    return this.running;
  }
}
