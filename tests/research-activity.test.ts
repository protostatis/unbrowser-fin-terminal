import assert from "node:assert/strict";
import test from "node:test";
import { hasActiveResearchState, isActiveResearchFramePayload } from "../server/research-activity.js";

test("trusted frame research activity recognizes running and queued jobs", () => {
  assert.equal(hasActiveResearchState({ research: { active: true, phase: "running" } }), true);
  assert.equal(hasActiveResearchState({ researchQueue: [{ phase: "dispatched" }] }), true);
  assert.equal(hasActiveResearchState({ research: { active: false, phase: "settled" } }), false);
});

test("only an active frame payload refreshes a public research idle lease", () => {
  assert.equal(isActiveResearchFramePayload(JSON.stringify({
    type: "frame",
    state: { research: { active: true, phase: "running" } },
  })), true);
  assert.equal(isActiveResearchFramePayload(JSON.stringify({
    type: "frame",
    state: { research: { active: false, phase: "settled" } },
  })), false);
  assert.equal(isActiveResearchFramePayload(JSON.stringify({
    type: "input",
    state: { research: { active: true } },
  })), false);
  assert.equal(isActiveResearchFramePayload("not-json"), false);
});
