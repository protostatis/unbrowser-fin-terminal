/**
 * Browser stub for node:child_process (stage 2a loadability spike).
 *
 * The extension imports research-worker-coordinator, which imports `fork`.
 * The browser alpha has no worker processes — the stage-3 agent-session
 * design runs research through the session's own tool loop instead.
 */

export function fork(): never {
	throw new Error("child_process.fork: browser worker processes not implemented (stage 3)");
}
