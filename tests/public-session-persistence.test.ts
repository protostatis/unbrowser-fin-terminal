import assert from "node:assert/strict";
import test from "node:test";
import { PublicSessionPersistence } from "../server/public-session-persistence.js";

const state = {
  version: 1 as const,
  dailyBudgetDay: "2026-08-02",
  dailyReservedMicroUsd: 1_000_000,
  queue: ["ticket-1"],
  sessions: [],
  workers: [{ id: "seat-01" }],
};

test("development memory persistence keeps a single gateway lease and restart state", async () => {
  const url = `memory://test-${process.pid}-${Date.now()}`;
  const first = new PublicSessionPersistence(url, "gateway-a");
  const second = new PublicSessionPersistence(url, "gateway-b");
  await first.connect();
  await first.save(state);
  await assert.rejects(() => second.connect(), /already holds the admission lease/);
  await first.close();

  await second.connect();
  assert.deepEqual(await second.load(), state);
  await second.close();
});
