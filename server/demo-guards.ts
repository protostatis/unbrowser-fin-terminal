/**
 * Demo-mode abuse guards: per-IP fixed-window counters for WebSocket
 * connections and client messages. The public demo is a single shared seat,
 * so these are defense in depth — they slow scripted clients, while the idle
 * watchdog and the absolute session cap bound how long any client can hold
 * the seat. Production mode never instantiates these.
 *
 * Keys are the real client IP, which the edge proxy injects as X-Real-IP;
 * the terminal never trusts a client-supplied header.
 */

export interface DemoRateLimiter {
  /** True when this IP may open another WebSocket connection. */
  allowConnection(ip: string): boolean;
  /** True when this IP may send another client key input. */
  allowInput(ip: string): boolean;
}

interface WindowCounter {
  count: number;
  windowStartedAt: number;
}

/**
 * Fixed-window per-key counter. A key (an IP) may take at most `limit` calls
 * inside any `windowMs` span; excess calls return false. Buckets for keys
 * unused for two windows are pruned so rotated-IP attackers cannot grow the
 * map without bound.
 */
export function createDemoRateLimiter(options?: {
  connectionLimit?: number;
  connectionWindowMs?: number;
  inputLimit?: number;
  inputWindowMs?: number;
}): DemoRateLimiter {
  const connectionLimit = options?.connectionLimit ?? 4;
  const connectionWindowMs = options?.connectionWindowMs ?? 10_000;
  const inputLimit = options?.inputLimit ?? 30;
  const inputWindowMs = options?.inputWindowMs ?? 10_000;

  const make = (limit: number, windowMs: number) => {
    const buckets = new Map<string, WindowCounter>();
    return (key: string): boolean => {
      const now = Date.now();
      const bucket = buckets.get(key);
      if (!bucket || now - bucket.windowStartedAt >= windowMs) {
        if (buckets.size > 4096) {
          for (const [candidate, value] of buckets) {
            if (now - value.windowStartedAt > windowMs * 2) buckets.delete(candidate);
          }
        }
        buckets.set(key, { count: 1, windowStartedAt: now });
        return true;
      }
      if (bucket.count >= limit) return false;
      bucket.count += 1;
      return true;
    };
  };

  const connections = make(connectionLimit, connectionWindowMs);
  const inputs = make(inputLimit, inputWindowMs);

  return {
    allowConnection(ip) {
      return connections(ip);
    },
    allowInput(ip) {
      return inputs(ip);
    },
  };
}
