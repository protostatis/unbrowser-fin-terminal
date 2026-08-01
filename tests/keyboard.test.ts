import assert from "node:assert/strict";
import test from "node:test";
import {
  isEditableTarget,
  isTerminalControl,
  keyToData,
} from "../web/src/keyboard.js";

/** Fake DOM element whose closest() only matches a single selector category. */
function fakeTarget(kind: "editable" | "control" | "none") {
  return {
    closest(selector: string) {
      if (kind === "editable" && selector.includes("textarea")) return {};
      if (kind === "control" && selector.includes("button")) return {};
      return null;
    },
  };
}

function event(partial: Partial<{
  key: string;
  target: unknown;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
}> = {}): KeyboardEvent {
  return {
    key: "a",
    target: null,
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    ...partial,
  } as unknown as KeyboardEvent;
}

test("editable targets are never captured by the terminal", () => {
  const editable = fakeTarget("editable");
  assert.equal(isEditableTarget(editable as never), true);
  assert.equal(keyToData(event({ key: "Tab", target: editable })), null);
  assert.equal(keyToData(event({ key: "j", target: editable })), null);
  assert.equal(keyToData(event({ key: "ArrowDown", target: editable })), null);
});

test("buttons and links keep browser Tab by default", () => {
  const control = fakeTarget("control");
  assert.equal(isTerminalControl(control as never), true);
  assert.equal(keyToData(event({ key: "Tab", target: control })), null);
  // Non-Tab keys on a control stay uncaptured (unchanged behavior).
  assert.equal(keyToData(event({ key: "j", target: control })), null);
  assert.equal(keyToData(event({ key: "Enter", target: control })), null);
  assert.equal(keyToData(event({ key: "ArrowUp", target: control })), null);
});

test("default key mapping outside controls is unchanged", () => {
  assert.equal(keyToData(event({ key: "Tab" })), "\t");
  assert.equal(keyToData(event({ key: "Enter" })), "\r");
  assert.equal(keyToData(event({ key: "Escape" })), "\x1b");
  assert.equal(keyToData(event({ key: "ArrowUp" })), "\x1b[A");
  assert.equal(keyToData(event({ key: "ArrowDown" })), "\x1b[B");
  assert.equal(keyToData(event({ key: "ArrowRight" })), "\x1b[C");
  assert.equal(keyToData(event({ key: "ArrowLeft" })), "\x1b[D");
  assert.equal(keyToData(event({ key: "PageUp" })), "\x1b[5~");
  assert.equal(keyToData(event({ key: "PageDown" })), "\x1b[6~");
  assert.equal(keyToData(event({ key: "Home" })), "\x1b[H");
  assert.equal(keyToData(event({ key: "End" })), "\x1b[F");
  assert.equal(keyToData(event({ key: "j" })), "j");
  assert.equal(keyToData(event({ key: "J" })), "J");
  assert.equal(keyToData(event({ key: "/" })), "/");
});

test("modifier-only, F-keys, and unmapped keys are not forwarded", () => {
  assert.equal(keyToData(event({ key: "Shift" })), null);
  assert.equal(keyToData(event({ key: "F5" })), null);
  assert.equal(keyToData(event({ key: "j", metaKey: true })), null);
  assert.equal(keyToData(event({ key: "j", ctrlKey: true })), null);
});
