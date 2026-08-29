import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";

const PRINCIPAL_PATTERN = /^[A-Za-z0-9._:-]{1,160}$/;

export function singleHeader(req: IncomingMessage, name: string): string | undefined {
  const values: string[] = [];
  for (let i = 0; i < req.rawHeaders.length; i += 2) {
    if (req.rawHeaders[i]?.toLowerCase() === name) values.push(req.rawHeaders[i + 1] ?? "");
  }
  return values.length === 1 ? values[0] : undefined;
}

export function matchesProxyToken(expectedToken: string, value: string | undefined): boolean {
  if (!expectedToken) return true;
  if (!value) return false;
  const actual = Buffer.from(value);
  const expected = Buffer.from(expectedToken);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export function normalizePrincipal(value: string | undefined, proxyAuthEnabled: boolean): string | undefined {
  if (!proxyAuthEnabled) return "local";
  return value && PRINCIPAL_PATTERN.test(value) ? value : undefined;
}

/** A provisioned private runtime may only accept its owning account principal. */
export function matchesPrivateWorkspacePrincipal(
  principal: string | undefined,
  accountSessionId: string | undefined,
  proxyAuthEnabled: boolean,
): boolean {
  if (!proxyAuthEnabled) return principal === "local";
  const sessionId = accountSessionId?.trim();
  return Boolean(sessionId) && principal === `account:${sessionId}`;
}

export class PrincipalLease {
  private principal: string | undefined;

  claim(principal: string): boolean {
    if (this.principal && this.principal !== principal) return false;
    this.principal = principal;
    return true;
  }

  get assignedPrincipal(): string | undefined {
    return this.principal;
  }
}
