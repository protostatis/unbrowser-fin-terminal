import { createClient, type RedisClientType } from "redis";
import type { PublicSessionCoordinatorState } from "./public-session-coordinator.js";

const LOCK_TTL_MS = 15_000;
const RENEW_LOCK_SCRIPT = `
  if redis.call('GET', KEYS[1]) == ARGV[1] then
    return redis.call('PEXPIRE', KEYS[1], ARGV[2])
  end
  return 0
`;
const RELEASE_LOCK_SCRIPT = `
  if redis.call('GET', KEYS[1]) == ARGV[1] then
    return redis.call('DEL', KEYS[1])
  end
  return 0
`;
type MemoryState = { state?: string; owner?: string; leaseExpiresAt?: number };
const memoryStores = new Map<string, MemoryState>();

/**
 * Redis gives the initial pilot a durable queue/budget and ensures only one
 * gateway mutates it. The gateway intentionally fails closed if its lease is
 * lost instead of allowing two processes to assign the same worker.
 */
export class PublicSessionPersistence {
  private readonly client?: RedisClientType;
  private readonly memoryKey?: string;
  private readonly stateKey: string;
  private readonly lockKey: string;
  private connected = false;

  constructor(
    redisUrl: string,
    private readonly instanceId: string,
    namespace = "fin-terminal-public:v1",
  ) {
    if (redisUrl.startsWith("memory://")) {
      this.memoryKey = `${namespace}:${redisUrl}`;
    } else {
      this.client = createClient({ url: redisUrl });
    }
    this.stateKey = `${namespace}:state`;
    this.lockKey = `${namespace}:gateway-lock`;
  }

  async connect(): Promise<void> {
    if (this.memoryKey) {
      const store = memoryStores.get(this.memoryKey) ?? {};
      if (store.owner && store.owner !== this.instanceId && (store.leaseExpiresAt ?? 0) > Date.now()) {
        throw new Error("another public session gateway already holds the admission lease");
      }
      store.owner = this.instanceId;
      store.leaseExpiresAt = Date.now() + LOCK_TTL_MS;
      memoryStores.set(this.memoryKey, store);
      this.connected = true;
      return;
    }
    const client = this.client!;
    client.on("error", (error) => console.error("[public-session-store] redis error:", error.message));
    await client.connect();
    this.connected = true;
    const acquired = await client.set(this.lockKey, this.instanceId, { NX: true, PX: LOCK_TTL_MS });
    if (acquired !== "OK") {
      await this.close();
      throw new Error("another public session gateway already holds the admission lease");
    }
  }

  async load(): Promise<PublicSessionCoordinatorState | undefined> {
    this.assertConnected();
    const raw = this.memoryKey
      ? memoryStores.get(this.memoryKey)?.state
      : await this.client!.get(this.stateKey);
    if (!raw) return undefined;
    try {
      return JSON.parse(raw) as PublicSessionCoordinatorState;
    } catch {
      throw new Error("stored public session state is invalid JSON");
    }
  }

  async save(state: PublicSessionCoordinatorState): Promise<void> {
    this.assertConnected();
    if (!(await this.renewLease())) {
      throw new Error("public session gateway lost its Redis admission lease");
    }
    if (this.memoryKey) {
      const store = memoryStores.get(this.memoryKey)!;
      store.state = JSON.stringify(state);
    } else {
      await this.client!.set(this.stateKey, JSON.stringify(state));
    }
  }

  async renewLease(): Promise<boolean> {
    this.assertConnected();
    if (this.memoryKey) {
      const store = memoryStores.get(this.memoryKey);
      if (!store || store.owner !== this.instanceId) return false;
      store.leaseExpiresAt = Date.now() + LOCK_TTL_MS;
      return true;
    }
    const result = await this.client!.eval(RENEW_LOCK_SCRIPT, {
      keys: [this.lockKey],
      arguments: [this.instanceId, String(LOCK_TTL_MS)],
    });
    return result === 1;
  }

  async close(): Promise<void> {
    if (!this.connected) return;
    if (this.memoryKey) {
      const store = memoryStores.get(this.memoryKey);
      if (store?.owner === this.instanceId) {
        store.owner = undefined;
        store.leaseExpiresAt = undefined;
      }
      this.connected = false;
      return;
    }
    const client = this.client!;
    try {
      await client.eval(RELEASE_LOCK_SCRIPT, {
        keys: [this.lockKey],
        arguments: [this.instanceId],
      });
    } catch {
      // Redis may be down during shutdown; its TTL still releases the lease.
    }
    try {
      await client.quit();
    } catch {
      client.disconnect();
    }
    this.connected = false;
  }

  private assertConnected(): void {
    if (!this.connected) throw new Error("public session persistence is not connected");
  }
}
