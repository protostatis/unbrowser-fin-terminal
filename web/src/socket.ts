/**
 * WebSocket client for the Pi market-terminal backend.
 *
 * Connects to `${wsProtocol}://${host}/ws` — the Vite dev proxy handles /ws
 * in development; the same path works behind a production reverse proxy.
 *
 * Uses an event-emitter pattern: call .on(type, handler) and receive parsed
 * message objects. Built-in event types mirror the server→client protocol:
 *   frame, notify, select_request, closed
 * plus connection lifecycle:
 *   _open, _close, _connecting
 *
 * Example:
 *   const sock = new TerminalSocket();
 *   sock.on("frame", (msg) => setRows(msg.rows));
 *   sock.connect();
 */

type Handler = (data: any) => void;

/* ── Server-to-client message shapes ──────────────────────────────────── */

export interface FrameMessage {
  type: "frame";
  rows: string[];
  width: number;
  rows_count: number;
  state?: Record<string, unknown>;
}

export interface NotifyMessage {
  type: "notify";
  level: "info" | "warning" | "error";
  message: string;
}

export interface SelectRequestMessage {
  type: "select_request";
  id: string;
  title: string;
  options: string[];
}

export interface ClosedMessage {
  type: "closed";
}

export type ServerMessage =
  | FrameMessage
  | NotifyMessage
  | SelectRequestMessage
  | ClosedMessage;

/* ── Socket class ─────────────────────────────────────────────────────── */

const RECONNECT_BASE_MS = 500;
const RECONNECT_MAX_MS = 8_000;
const MAX_RETRIES = 20;

export class TerminalSocket {
  private ws: WebSocket | null = null;
  private handlers = new Map<string, Set<Handler>>();
  private retryTimeout: ReturnType<typeof setTimeout> | null = null;
  private retryCount = 0;
  private _disconnected = false;

  /** Read-only connection indicator for quick UI checks. */
  connectionState: "connecting" | "connected" | "disconnected" =
    "disconnected";

  /* ── Event subscription ─────────────────────────────────────────────── */

  /** Subscribe to a message type. Returns an unsubscribe function. */
  on(type: string, handler: Handler): () => void {
    if (!this.handlers.has(type)) this.handlers.set(type, new Set());
    this.handlers.get(type)!.add(handler);
    return () => this.handlers.get(type)?.delete(handler);
  }

  /** Dispatch an event to all subscribers of that type. */
  private dispatch(type: string, data: unknown): void {
    this.handlers.get(type)?.forEach((h) => h(data));
  }

  /* ── Lifecycle ──────────────────────────────────────────────────────── */

  /** Open (or re-open) the WebSocket connection. */
  connect(): void {
    if (this._disconnected) return;
    if (
      this.ws &&
      (this.ws.readyState === WebSocket.OPEN ||
        this.ws.readyState === WebSocket.CONNECTING)
    )
      return;

    this.setConnectionState("connecting");
    this.dispatch("_connecting", {});

    const protocol = location.protocol === "https:" ? "wss" : "ws";
    const url = `${protocol}://${location.host}/ws`;
    this.ws = new WebSocket(url);

    this.ws.onopen = () => {
      this.retryCount = 0;
      this.setConnectionState("connected");
      this.dispatch("_open", {});
    };

    this.ws.onmessage = (event: MessageEvent) => {
      try {
        const msg: ServerMessage = JSON.parse(event.data);
        this.dispatch(msg.type, msg);
      } catch (err) {
        console.error("TerminalSocket: failed to parse message", err);
      }
    };

    this.ws.onclose = () => {
      this.setConnectionState("disconnected");
      this.dispatch("_close", {});
      if (!this._disconnected) this.scheduleReconnect();
    };

    this.ws.onerror = () => {
      // onclose fires after onerror, so reconnect is handled there.
    };
  }

  /** Gracefully close the connection and stop reconnecting. */
  disconnect(): void {
    this._disconnected = true;
    if (this.retryTimeout) {
      clearTimeout(this.retryTimeout);
      this.retryTimeout = null;
    }
    this.ws?.close();
    this.ws = null;
    this.setConnectionState("disconnected");
  }

  /* ── Send helpers (client → server) ─────────────────────────────────── */

  sendInput(data: string): void {
    this.send({ type: "input", data });
  }

  sendResize(cols: number, rows: number): void {
    this.send({ type: "resize", cols, rows });
  }

  sendCommand(name: string, args: string): void {
    this.send({ type: "command", name, args });
  }

  sendSelectResponse(
    id: string,
    value?: string,
    cancelled?: boolean,
  ): void {
    this.send({ type: "select_response", id, value, cancelled });
  }

  /* ── Internals ──────────────────────────────────────────────────────── */

  private send(data: Record<string, unknown>): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(data));
    }
  }

  private setConnectionState(
    state: "connecting" | "connected" | "disconnected",
  ): void {
    this.connectionState = state;
  }

  private scheduleReconnect(): void {
    if (this.retryCount >= MAX_RETRIES) return;
    const delay = Math.min(
      RECONNECT_BASE_MS * Math.pow(2, this.retryCount),
      RECONNECT_MAX_MS,
    );
    this.retryCount++;
    this.setConnectionState("connecting");
    this.dispatch("_connecting", {});
    this.retryTimeout = setTimeout(() => this.connect(), delay);
  }
}
