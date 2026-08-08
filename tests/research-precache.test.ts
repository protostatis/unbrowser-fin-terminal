import assert from "node:assert/strict";
import test from "node:test";
import {
  isResearchFreshToDate,
  precacheWarmCapacity,
} from "../.pi/extensions/market-terminal.js";

test("isResearchFreshToDate treats only the current UTC calendar date as fresh", () => {
  const now = Date.UTC(2026, 7, 6, 15, 30, 0);
  assert.equal(isResearchFreshToDate(Date.UTC(2026, 7, 6, 0, 0, 1), now), true);
  assert.equal(isResearchFreshToDate(Date.UTC(2026, 7, 6, 23, 59, 59), now), true);
  assert.equal(isResearchFreshToDate(Date.UTC(2026, 7, 5, 23, 59, 59), now), false);
  assert.equal(isResearchFreshToDate(Date.UTC(2026, 7, 7, 0, 0, 0), now), false, "future canvases are not usable");
});

test("isResearchFreshToDate is calendar-date based across month and year boundaries", () => {
  assert.equal(
    isResearchFreshToDate(Date.UTC(2026, 5, 30, 23, 59, 0), Date.UTC(2026, 6, 1, 0, 1, 0)),
    false,
  );
  assert.equal(
    isResearchFreshToDate(Date.UTC(2025, 11, 31, 20, 0, 0), Date.UTC(2026, 0, 1, 1, 0, 0)),
    false,
  );
  assert.equal(
    isResearchFreshToDate(Date.UTC(2028, 1, 29, 8, 0, 0), Date.UTC(2028, 1, 29, 18, 0, 0)),
    true,
  );
});

test("precacheWarmCapacity keeps one worker slot reserved for interactive research", () => {
  assert.equal(precacheWarmCapacity(6, 24), 5);
  assert.equal(precacheWarmCapacity(6, 2), 2);
  assert.equal(precacheWarmCapacity(3, 24), 2);
  assert.equal(precacheWarmCapacity(1, 24), 0);
  assert.equal(precacheWarmCapacity(0, 24), 0);
});
