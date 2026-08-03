import assert from "node:assert/strict";
import test from "node:test";
import {
  isReplayDemoBuild,
  PUBLIC_DEMO,
  PUBLIC_LIVE_DEMO,
  REPLAY_DEMO,
  REPLAY_DEMO_SEGMENT,
  resolveTerminalBuildMode,
} from "../web/src/demo-mode.js";

test("demo segment constant is the exact fin-terminal-demo path segment", () => {
  assert.equal(REPLAY_DEMO_SEGMENT, "fin-terminal-demo");
});

test("replay demo detection matches a fin-terminal-demo path segment", () => {
  // The kiosk build is deployed under /unbrowser/fin-terminal-demo/.
  assert.equal(isReplayDemoBuild("/unbrowser/fin-terminal-demo/"), true);
  // Segment may appear at any depth, with or without trailing slash.
  assert.equal(isReplayDemoBuild("/fin-terminal-demo/"), true);
  assert.equal(isReplayDemoBuild("/fin-terminal-demo"), true);
  assert.equal(isReplayDemoBuild("/unbrowser/fin-terminal-demo/index.html"), true);
});

test("replay demo detection never matches lookalike segments", () => {
  for (const baseUrl of [
    "/",
    "",
    "/unbrowser/",
    "/unbrowser/not-fin-terminal-demo/",
    "/unbrowser/xfin-terminal-demo/",
    "/unbrowser/fin-terminal-demo-2/",
    "/unbrowser/fin-terminal-demo-backup/",
    "/unbrowser/fin_terminal_demo/",
    "/unbrowser/fin-terminal-demo2/",
    "/unbrowser/fin-terminal-demo.sandbox/",
    "/unbrowser/fin-terminal-demo%2f/",
    "/unbrowser/Fin-Terminal-Demo/",
  ]) {
    assert.equal(isReplayDemoBuild(baseUrl), false, baseUrl);
  }
});

test("live deployments never resolve to the replay build", () => {
  // Root and ordinary subpath deployments stay live.
  assert.equal(isReplayDemoBuild("/"), false);
  assert.equal(isReplayDemoBuild("/unbrowser/fin-terminal/"), false);
});

test("flags are booleans and agree with the segment matcher", () => {
  assert.equal(typeof REPLAY_DEMO, "boolean");
  assert.equal(typeof PUBLIC_DEMO, "boolean");
  assert.equal(typeof PUBLIC_LIVE_DEMO, "boolean");
  // PUBLIC_DEMO is the backwards-compatible alias for the unchanged live
  // terminal; the kiosk deployment is now the replay-only build.
  assert.equal(REPLAY_DEMO, PUBLIC_DEMO);
});

test("explicit public-live builds retain the demo URL without selecting replay", () => {
  assert.equal(
    resolveTerminalBuildMode("/fin-terminal-demo/", "public-live"),
    "public-live",
  );
  assert.equal(resolveTerminalBuildMode("/fin-terminal-demo/", "live"), "live");
  assert.equal(resolveTerminalBuildMode("/fin-terminal-demo/"), "replay");
});
