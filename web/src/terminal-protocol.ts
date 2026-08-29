import type { TerminalFrameState } from "./mobile-controls";
import type { TerminalWebAction } from "./web-interactions";

export type TerminalConnectionState = "connecting" | "connected" | "disconnected";

/* ── Server-to-client message shapes ──────────────────────────────────── */

export interface FrameMessage {
  type: "frame";
  rows: string[];
  width: number;
  rows_count: number;
  state?: TerminalFrameState;
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

/** A message from the server indicating the session is closed. */
export interface ClosedMessage {
  type: "closed";
}

/** The union of all possible messages received from the server. */
export type ServerMessage =
  | FrameMessage
  | NotifyMessage
  | SelectRequestMessage
  | ClosedMessage;

/* ── Lifecycle events ─────────────────────────────────────────────────── */

/**
 * The core interface for any backend providing terminal functionality.
 * Implementation details (WebSocket, polling, mock, etc.) are hidden.
 */
export interface TerminalClient {
  /** Read-only connection indicator for quick UI checks. */
  readonly connectionState: TerminalConnectionState;

  /**
   * Subscribe to terminal events. Returns an unsubscribe function.
   *
   * Supported event types and payloads:
   * - 'frame': FrameMessage
   * - 'notify': NotifyMessage
   * - 'select_request': SelectRequestMessage
   * - 'closed': ClosedMessage
   * - '_open': void
   * - '_close': { replaced: boolean; code: number; reason: string }
   * - '_connecting': void
   */
  on(type: string, handler: (payload: any) => void): () => void;

  /** Open (or re-open) the terminal connection. */
  connect(): void;

  /** Gracefully close the connection and stop all activity. */
  disconnect(): void;

  /** Send raw text input to the terminal. */
  sendInput(data: string): void;

  /** Send a validated semantic browser action to the terminal bridge. */
  sendWebAction(action: TerminalWebAction): void;

  /** Send terminal viewport resize. */
  sendResize(cols: number, rows: number): void;

  /** Send a command to the terminal. */
  sendCommand(name: string, args: string): void;

  /** Send a response to a pending select request. */
  sendSelectResponse(id: string, value?: string, cancelled?: boolean): void;
}
