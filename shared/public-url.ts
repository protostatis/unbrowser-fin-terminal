const TRACKING_QUERY_KEY = /^(?:utm_|fbclid$|gclid$|mc_)/i;

function isSensitiveQueryKey(key: string): boolean {
  const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, "");
  return normalized === "key"
    || normalized === "auth"
    || normalized === "authorization"
    || normalized === "bearer"
    || normalized === "code"
    || normalized === "nonce"
    || normalized === "password"
    || normalized === "session"
    || normalized.endsWith("apikey")
    || normalized.endsWith("credential")
    || normalized.endsWith("secret")
    || normalized.endsWith("signature")
    || normalized.endsWith("token")
    || normalized.endsWith("key");
}

/**
 * Return a safe, shareable public-web URL or an empty string. This boundary is
 * used before URLs enter archived research or become browser links.
 */
export function sanitizePublicUrl(raw: string): string {
  const value = raw.trim();
  if (!value) return "";

  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return "";
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return "";
  if (parsed.username || parsed.password) return "";
  if (
    (parsed.protocol === "http:" && parsed.port !== "" && parsed.port !== "80") ||
    (parsed.protocol === "https:" && parsed.port !== "" && parsed.port !== "443")
  ) return "";

  const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (
    !host ||
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host.endsWith(".internal") ||
    host.endsWith(".home.arpa")
  ) return "";
  if (host.includes(":") || /^\d+$/.test(host)) return "";

  const ipv4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipv4) {
    const octets = ipv4.slice(1).map(Number);
    if (octets.some((part) => part > 255)) return "";
    const [a, b] = octets;
    if (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      a! >= 224 ||
      (a === 100 && b! >= 64 && b! <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b! >= 16 && b! <= 31) ||
      (a === 192 && (b === 0 || b === 168)) ||
      (a === 198 && (b === 18 || b === 19))
    ) return "";
  }

  for (const key of [...parsed.searchParams.keys()]) {
    // Signed and credential-bearing URLs must never be archived or rendered,
    // even with a redacted value: the remaining signature parameters can be
    // enough to leak a usable capability or internal account metadata.
    if (isSensitiveQueryKey(key)) return "";
    if (TRACKING_QUERY_KEY.test(key)) {
      parsed.searchParams.delete(key);
    }
  }
  parsed.hash = "";
  return parsed.href;
}
