/** Whole-runtime Web Lock for the browser alpha. */

export const BROWSER_RUNTIME_LOCK_NAME = "unbrowser-fin-terminal:runtime";

export interface BrowserLocksLike {
	request<T>(name: string, options: { mode: "exclusive"; ifAvailable: true }, callback: (lock: Lock | null) => Promise<T> | T): Promise<T>;
}

export interface BrowserRuntimeLease {
	release(): Promise<void>;
}

export interface BrowserRuntimeLockOptions {
	locks?: BrowserLocksLike;
	name?: string;
}

function browserLocks(options: BrowserRuntimeLockOptions): BrowserLocksLike {
	const locks = Object.prototype.hasOwnProperty.call(options, "locks")
		? options.locks
		: (globalThis.navigator as Navigator & { locks?: BrowserLocksLike }).locks;
	if (!locks) throw new Error("Web Locks API is unavailable; browser session is disabled");
	return locks;
}

/**
 * Acquire the lock for the lifetime of the connected runtime, not merely a
 * write. That prevents stale in-memory archive maps in another tab from
 * overwriting this tab's completed research.
 */
export async function acquireBrowserRuntimeLock(options: BrowserRuntimeLockOptions = {}): Promise<BrowserRuntimeLease> {
	const locks = browserLocks(options);
	const name = options.name ?? BROWSER_RUNTIME_LOCK_NAME;
	let resolveAcquired!: () => void;
	let rejectAcquired!: (error: unknown) => void;
	let releaseHold!: () => void;
	let released = false;
	const acquired = new Promise<void>((resolve, reject) => {
		resolveAcquired = resolve;
		rejectAcquired = reject;
	});
	const hold = new Promise<void>((resolve) => { releaseHold = resolve; });
	const request = locks.request(name, { mode: "exclusive", ifAvailable: true }, async (lock) => {
		if (!lock) {
			rejectAcquired(new Error("A browser session is already active in another tab"));
			return;
		}
		resolveAcquired();
		await hold;
	});
	// A lock implementation may reject before invoking the callback.
	void request.catch(rejectAcquired);
	await acquired;
	return {
		async release(): Promise<void> {
			if (released) return;
			released = true;
			releaseHold();
			await request;
		},
	};
}
