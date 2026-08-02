import assert from "node:assert/strict";
import test from "node:test";
import { PublicSessionWorkerLifecycle, type PublicWorkerEndReason } from "../server/public-session-worker.js";

function lifecycle() {
  let now = 0;
  let nextId = 0;
  const timers = new Map<number, { at: number; fn: () => void }>();
  const ended: PublicWorkerEndReason[] = [];
  const instance = new PublicSessionWorkerLifecycle({
    idleTimeoutMs: 300,
    absoluteTimeoutMs: 900,
    reconnectGraceMs: 30,
    onEnd: (reason) => ended.push(reason),
    now: () => now,
    setTimeout: ((fn: () => void, delay: number) => {
      const id = ++nextId;
      timers.set(id, { at: now + delay, fn });
      return id as unknown as ReturnType<typeof setTimeout>;
    }) as typeof setTimeout,
    clearTimeout: ((id: number) => {
      timers.delete(id);
    }) as typeof clearTimeout,
  });
  return {
    instance,
    ended,
    advance(ms: number) {
      now += ms;
      for (const [id, timer] of [...timers]) {
        if (timer.at > now) continue;
        timers.delete(id);
        timer.fn();
      }
    },
  };
}

test("public worker ends an idle visitor session exactly once", () => {
  const { instance, ended, advance } = lifecycle();
  instance.connectedClient();
  advance(299);
  assert.deepEqual(ended, []);
  advance(1);
  assert.deepEqual(ended, ["idle-timeout"]);
  advance(900);
  assert.deepEqual(ended, ["idle-timeout"]);
});

test("meaningful activity extends idle time but never the absolute worker lifetime", () => {
  const { instance, ended, advance } = lifecycle();
  instance.connectedClient();
  advance(250);
  instance.touch();
  advance(250);
  instance.touch();
  advance(299);
  instance.touch();
  advance(100);
  assert.deepEqual(ended, []);
  advance(1);
  assert.deepEqual(ended, ["absolute-timeout"]);
});

test("a short reconnect survives but a disconnected visitor destroys the worker", () => {
  const { instance, ended, advance } = lifecycle();
  instance.connectedClient();
  instance.disconnectedClient();
  advance(29);
  instance.connectedClient();
  advance(2);
  assert.deepEqual(ended, []);
  instance.disconnectedClient();
  advance(30);
  assert.deepEqual(ended, ["disconnect-timeout"]);
});
