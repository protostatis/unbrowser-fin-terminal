/** Lifecycle guard for one disposable public Pi worker process. */

export type PublicWorkerEndReason = "idle-timeout" | "absolute-timeout" | "disconnect-timeout";

export interface PublicSessionWorkerLifecycleOptions {
  idleTimeoutMs: number;
  absoluteTimeoutMs: number;
  reconnectGraceMs: number;
  onEnd: (reason: PublicWorkerEndReason) => void;
  now?: () => number;
  setTimeout?: typeof globalThis.setTimeout;
  clearTimeout?: typeof globalThis.clearTimeout;
}

function positive(name: string, value: number): void {
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
}

/**
 * A worker process owns exactly one public visitor. Once it ends, the process
 * exits and Compose supplies a fresh module/global-state instance for the next
 * visitor. Reconnect grace preserves a brief browser refresh without reusing a
 * session for a different principal.
 */
export class PublicSessionWorkerLifecycle {
  private readonly now: () => number;
  private readonly setTimeout: typeof globalThis.setTimeout;
  private readonly clearTimeout: typeof globalThis.clearTimeout;
  private startedAt: number | undefined;
  private connected = false;
  private ended = false;
  private idleTimer: ReturnType<typeof globalThis.setTimeout> | undefined;
  private absoluteTimer: ReturnType<typeof globalThis.setTimeout> | undefined;
  private disconnectTimer: ReturnType<typeof globalThis.setTimeout> | undefined;

  constructor(private readonly options: PublicSessionWorkerLifecycleOptions) {
    positive("idleTimeoutMs", options.idleTimeoutMs);
    positive("absoluteTimeoutMs", options.absoluteTimeoutMs);
    positive("reconnectGraceMs", options.reconnectGraceMs);
    this.now = options.now ?? Date.now;
    this.setTimeout = options.setTimeout ?? globalThis.setTimeout;
    this.clearTimeout = options.clearTimeout ?? globalThis.clearTimeout;
  }

  connectedClient(): void {
    if (this.ended) return;
    const now = this.now();
    if (this.startedAt === undefined) {
      this.startedAt = now;
      this.absoluteTimer = this.setTimeout(
        () => this.end("absolute-timeout"),
        this.options.absoluteTimeoutMs,
      );
    }
    this.connected = true;
    this.clearDisconnectTimer();
    this.touch();
  }

  /** A validated input/action keeps an attached public session alive. */
  touch(): void {
    if (this.ended || !this.connected) return;
    if (this.idleTimer) this.clearTimeout(this.idleTimer);
    this.idleTimer = this.setTimeout(() => this.end("idle-timeout"), this.options.idleTimeoutMs);
  }

  disconnectedClient(): void {
    if (this.ended) return;
    this.connected = false;
    if (this.idleTimer) {
      this.clearTimeout(this.idleTimer);
      this.idleTimer = undefined;
    }
    this.clearDisconnectTimer();
    this.disconnectTimer = this.setTimeout(
      () => this.end("disconnect-timeout"),
      this.options.reconnectGraceMs,
    );
  }

  dispose(): void {
    if (this.idleTimer) this.clearTimeout(this.idleTimer);
    if (this.absoluteTimer) this.clearTimeout(this.absoluteTimer);
    this.clearDisconnectTimer();
    this.idleTimer = undefined;
    this.absoluteTimer = undefined;
  }

  private clearDisconnectTimer(): void {
    if (this.disconnectTimer) this.clearTimeout(this.disconnectTimer);
    this.disconnectTimer = undefined;
  }

  private end(reason: PublicWorkerEndReason): void {
    if (this.ended) return;
    this.ended = true;
    this.dispose();
    this.options.onEnd(reason);
  }
}
