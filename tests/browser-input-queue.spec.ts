import { it, expect } from "vitest";
import { BrowserInputQueue } from "../web/chat/browser-input-queue.ts";

function gate() {
  let resolve!: () => void;
  return { promise: new Promise<void>((done) => { resolve = done; }), release: () => resolve() };
}

it("keeps selection and clipboard completion ahead of immediately following input", async () => {
  const queue = new BrowserInputQueue(), focus = gate(), clipboard = gate();
  const events: string[] = [];
  const first = queue.run(async () => { await focus.promise; events.push("select all"); });
  const selected = queue.run(async () => { events.push("read original"); return "原文 😀"; });
  const cut = queue.run(async () => { await clipboard.promise; expect(await selected).toBe("原文 😀"); events.push("delete selected"); });
  const typed = queue.input({ type: "text", text: "1" }, async () => events.push("type 1"));
  const drained = queue.drain();
  focus.release();
  await selected;
  expect(events).toEqual(["select all", "read original"]);
  clipboard.release();
  await Promise.all([first, cut, typed, drained]);
  expect(events).toEqual(["select all", "read original", "delete selected", "type 1"]);
});

it("does not execute later input after a failed clipboard write", async () => {
  const queue = new BrowserInputQueue(), clipboard = gate(), events: string[] = [];
  const failed = queue.run(async () => { await clipboard.promise; throw new Error("Clipboard denied"); });
  const following = queue.input({ type: "text", text: "later" }, async () => events.push("later"));
  const rejected = expect(failed).rejects.toThrow("Clipboard denied");
  const cancelled = expect(following).rejects.toMatchObject({ name: "AbortError" });
  const drained = expect(queue.drain()).rejects.toThrow("Clipboard denied");
  clipboard.release();
  await Promise.all([rejected, cancelled, drained]);
  expect(events).toEqual([]);
});

it("cancels pending work when control changes, while draining the active operation", async () => {
  const queue = new BrowserInputQueue(), active = gate(), events: string[] = [];
  const first = queue.run(() => active.promise);
  const pending = queue.run(async () => events.push("stale selection"));
  const cancelled = expect(pending).rejects.toMatchObject({ name: "AbortError" });
  queue.cancel();
  active.release();
  await Promise.all([first, cancelled, queue.drain()]);
  expect(events).toEqual([]);
});
