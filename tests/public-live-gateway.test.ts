import assert from "node:assert/strict";
import test from "node:test";
import { isAllowedPublicClientMessage } from "../server/public-live-gateway.js";

function message(value: unknown): string {
  return JSON.stringify(value);
}

test("public gateway forwards only bounded terminal protocol messages", () => {
  for (const value of [
    { type: "input", data: "j" },
    { type: "resize", cols: 120, rows: 40 },
    { type: "command", name: "market", args: "AAPL" },
    { type: "select_response", id: "select-1", value: "yes" },
    { type: "select_response", id: "select-1", cancelled: true },
    { type: "web_action", data: { action: "scroll", direction: "down", amount: 1 } },
  ]) {
    assert.equal(isAllowedPublicClientMessage(message(value)), true, JSON.stringify(value));
  }
});

test("public gateway rejects malformed, oversized, and unsupported browser protocol messages", () => {
  for (const value of [
    "not json",
    message(null),
    message({ type: "input", data: "" }),
    message({ type: "input", data: "x".repeat(65) }),
    message({ type: "resize", cols: 1, rows: 40 }),
    message({ type: "command", name: "shell", args: "whoami" }),
    message({ type: "select_response", id: "" }),
    message({ type: "web_action", data: [] }),
    message({ type: "unknown" }),
  ]) {
    assert.equal(isAllowedPublicClientMessage(value), false, value);
  }
});
