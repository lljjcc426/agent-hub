import { z } from "zod";

const point = {
  x: z.number().min(0).max(10000),
  y: z.number().min(0).max(10000),
};
export const browserInput = z.discriminatedUnion("type", [
  z.object({ type: z.literal("click"), ...point }).strict(),
  z
    .object({
      type: z.literal("pointer"),
      phase: z.enum(["move", "down", "up"]),
      ...point,
      button: z.enum(["none", "left", "middle", "right"]),
      clickCount: z.number().int().min(0).max(3),
      modifiers: z.number().int().min(0).max(15),
    })
    .strict(),
  z
    .object({
      type: z.literal("wheel"),
      ...point,
      deltaX: z.number().min(-3000).max(3000),
      deltaY: z.number().min(-3000).max(3000),
    })
    .strict(),
  z
    .object({ type: z.literal("text"), text: z.string().min(1).max(4000) })
    .strict(),
  z
    .object({
      type: z.literal("key"),
      key: z.string().min(1).max(80),
      code: z.string().max(80).optional(),
      modifiers: z.number().int().min(0).max(15).optional(),
    })
    .strict(),
]);
export type BrowserInput = z.infer<typeof browserInput>;

/** agent-browser's pinned stream protocol; explicit strings avoid null CDP fields in 0.27. */
export function inputMessages(event: BrowserInput): Record<string, unknown>[] {
  if (event.type === "pointer")
    return [
      {
        type: "input_mouse",
        eventType: {
          move: "mouseMoved",
          down: "mousePressed",
          up: "mouseReleased",
        }[event.phase],
        x: event.x,
        y: event.y,
        button: event.button,
        clickCount: event.clickCount,
        modifiers: event.modifiers,
      },
    ];
  if (event.type === "click")
    return ["mousePressed", "mouseReleased"].map((eventType) => ({
      type: "input_mouse",
      eventType,
      x: event.x,
      y: event.y,
      button: "left",
      clickCount: 1,
    }));
  if (event.type === "wheel")
    return [
      {
        type: "input_mouse",
        eventType: "mouseWheel",
        x: event.x,
        y: event.y,
        deltaX: event.deltaX,
        deltaY: event.deltaY,
      },
    ];
  if (event.type === "text")
    return [
      {
        type: "input_keyboard",
        eventType: "char",
        text: event.text,
        key: "",
        code: "",
      },
    ];
  const parts = event.key.split("+"),
    key = parts.at(-1)!;
  const modifiers =
    event.modifiers ??
    (parts.includes("Alt") ? 1 : 0) |
      (parts.includes("Control") ? 2 : 0) |
      (parts.includes("Meta") ? 4 : 0) |
      (parts.includes("Shift") ? 8 : 0);
  const codes: Record<string, number> = {
    Backspace: 8,
    Tab: 9,
    Enter: 13,
    Escape: 27,
    Space: 32,
    PageUp: 33,
    PageDown: 34,
    End: 35,
    Home: 36,
    ArrowLeft: 37,
    ArrowUp: 38,
    ArrowRight: 39,
    ArrowDown: 40,
    Delete: 46,
  };
  const windowsVirtualKeyCode =
    codes[key] ?? (key.length === 1 ? key.toUpperCase().charCodeAt(0) : 0);
  return ["keyDown", "keyUp"].map((eventType) => ({
    type: "input_keyboard",
    eventType,
    key,
    code: event.code ?? (key.length === 1 ? "Key" + key.toUpperCase() : key),
    text: eventType === "keyDown" && key === "Enter" ? "\r" : "",
    windowsVirtualKeyCode,
    modifiers,
  }));
}
