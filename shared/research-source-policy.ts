/**
 * Sources that consistently returned a bot-wall challenge in production and
 * had no successful extraction in the reviewed session set. Keep mixed-result
 * domains (for example Yahoo Finance and Investing.com) out of this list.
 */
export const KNOWN_BOT_WALL_DOMAINS = [
  "reuters.com",
  "seekingalpha.com",
  "spglobal.com",
  "wsj.com",
] as const;

export function knownBotWallDomainForUrl(rawUrl: string): string | undefined {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return undefined;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return undefined;
  const hostname = parsed.hostname.toLowerCase().replace(/\.$/, "");
  return KNOWN_BOT_WALL_DOMAINS.find(
    (domain) => hostname === domain || hostname.endsWith(`.${domain}`),
  );
}

export function filterKnownBotWallSources<T extends { url: string }>(sources: readonly T[]): {
  allowed: T[];
  blockedDomains: string[];
  blockedCount: number;
} {
  const allowed: T[] = [];
  const blockedDomains = new Set<string>();
  let blockedCount = 0;
  for (const source of sources) {
    const blockedDomain = knownBotWallDomainForUrl(source.url);
    if (blockedDomain) {
      blockedDomains.add(blockedDomain);
      blockedCount += 1;
      continue;
    }
    allowed.push(source);
  }
  return { allowed, blockedDomains: [...blockedDomains], blockedCount };
}
