import assert from "node:assert/strict";
import type { IncomingMessage } from "node:http";
import test from "node:test";
import {
  matchesProxyToken,
  normalizePrincipal,
  PrincipalLease,
  singleHeader,
} from "../server/proxy-auth.js";

function requestWithHeaders(rawHeaders: string[]): IncomingMessage {
  return { rawHeaders } as IncomingMessage;
}

test("proxy authentication requires one exact constant-time token", () => {
  assert.equal(matchesProxyToken("secret", "secret"), true);
  assert.equal(matchesProxyToken("secret", "wrong"), false);
  assert.equal(matchesProxyToken("secret", undefined), false);
  assert.equal(matchesProxyToken("", undefined), true);

  const request = requestWithHeaders([
    "X-Fin-Terminal-Proxy-Token", "one",
    "x-fin-terminal-proxy-token", "two",
  ]);
  assert.equal(singleHeader(request, "x-fin-terminal-proxy-token"), undefined);
});

test("principal values are constrained and pinned for the process lifetime", () => {
  assert.equal(normalizePrincipal("user_123:admin", true), "user_123:admin");
  assert.equal(normalizePrincipal("bad principal", true), undefined);
  assert.equal(normalizePrincipal("user\nspoof", true), undefined);
  assert.equal(normalizePrincipal(undefined, false), "local");

  const lease = new PrincipalLease();
  assert.equal(lease.claim("user-a"), true);
  assert.equal(lease.claim("user-a"), true);
  assert.equal(lease.claim("user-b"), false);
  assert.equal(lease.assignedPrincipal, "user-a");
});
