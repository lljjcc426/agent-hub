import { it, expect } from "vitest";
import { browserInput, inputMessages } from "../src/browser-input.ts";
it("preserves drag, right button, modifiers and scroll target coordinates", () => {
  expect(
    inputMessages({
      type: "pointer",
      phase: "move",
      x: 123,
      y: 456,
      button: "left",
      clickCount: 0,
      modifiers: 8,
    })[0],
  ).toMatchObject({
    eventType: "mouseMoved",
    button: "left",
    x: 123,
    y: 456,
    modifiers: 8,
  });
  expect(
    inputMessages({
      type: "pointer",
      phase: "down",
      x: 2,
      y: 3,
      button: "right",
      clickCount: 1,
      modifiers: 0,
    })[0],
  ).toMatchObject({ eventType: "mousePressed", button: "right" });
  expect(
    inputMessages({ type: "wheel", x: 20, y: 30, deltaX: 0, deltaY: 140 })[0],
  ).toMatchObject({ eventType: "mouseWheel", x: 20, y: 30, deltaY: 140 });
});
it("sends explicit keyboard strings for the pinned stream and releases every shortcut", () => {
  expect(inputMessages({ type: "text", text: "中文😀" })).toEqual([
    {
      type: "input_keyboard",
      eventType: "char",
      text: "中文😀",
      key: "",
      code: "",
    },
  ]);
  const events = inputMessages({
    type: "key",
    key: "a",
    code: "KeyA",
    modifiers: 4,
  });
  expect(events.map((e) => e.eventType)).toEqual(["keyDown", "keyUp"]);
  expect(events[0]).toMatchObject({
    key: "a",
    code: "KeyA",
    text: "",
    modifiers: 4,
    windowsVirtualKeyCode: 65,
  });
  expect(
    browserInput.safeParse({
      type: "pointer",
      phase: "move",
      x: 0,
      y: 0,
      button: "left",
      clickCount: 0,
      modifiers: 0,
      method: "Runtime.evaluate",
    }).success,
  ).toBe(false);
  expect(
    inputMessages({ type: "key", key: "Enter", code: "Enter" }).map(
      (e) => e.text,
    ),
  ).toEqual(["\r", ""]);
  expect(
    inputMessages({ type: "key", key: "Control+Shift+a" })[0],
  ).toMatchObject({ key: "a", code: "KeyA", modifiers: 10 });
});
