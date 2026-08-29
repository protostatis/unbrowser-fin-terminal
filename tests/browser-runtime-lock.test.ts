import assert from "node:assert/strict";
import test from "node:test";
import { acquireBrowserRuntimeLock } from "../web/src/harness/browser-runtime-lock.js";

class FakeLocks {
	private held = false;
	async request<T>(_name: string, _options: { mode: "exclusive"; ifAvailable: true }, callback: (lock: Lock | null) => Promise<T> | T): Promise<T> {
		if (this.held) return callback(null);
		this.held = true;
		try {
			return await callback({} as Lock);
		} finally {
			this.held = false;
		}
	}
}

test("runtime lock is held until release and rejects a second owner", async () => {
	const locks = new FakeLocks();
	const first = await acquireBrowserRuntimeLock({ locks, name: "test-runtime" });
	await assert.rejects(acquireBrowserRuntimeLock({ locks, name: "test-runtime" }), /already active/);
	await first.release();
	const second = await acquireBrowserRuntimeLock({ locks, name: "test-runtime" });
	await second.release();
});

test("runtime lock fails closed when Web Locks is unavailable", async () => {
	await assert.rejects(acquireBrowserRuntimeLock({ locks: undefined }), /Web Locks API is unavailable/);
});
