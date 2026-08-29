import assert from "node:assert/strict";
import test from "node:test";
import { createBrowserStoragePort } from "../web/src/harness/browser-storage.js";

type Callback = (() => void) | null;

class FakeRequest<T = unknown> {
	result!: T;
	error: Error | null = null;
	onupgradeneeded: Callback = null;
	onerror: Callback = null;
	onblocked: Callback = null;
}

class FakeStore {
	constructor(private readonly records: Map<string, { path: string; text: string }>) {}
	get(path: string): FakeRequest<{ path: string; text: string } | undefined> {
		const request = new FakeRequest<{ path: string; text: string } | undefined>();
		queueMicrotask(() => {
			request.result = this.records.get(path);
			(request as unknown as { onsuccess: Callback }).onsuccess?.();
		});
		return request;
	}
	put(record: { path: string; text: string }): void {
		this.records.set(record.path, record);
	}
}

class FakeTransaction {
	oncomplete: Callback = null;
	onerror: Callback = null;
	onabort: Callback = null;
	error: Error | null = null;
	constructor(private readonly store: FakeStore) {}
	objectStore(): FakeStore { return this.store; }
}

class FakeDb {
	readonly objectStoreNames = { contains: (name: string) => name === "files" };
	constructor(private readonly records: Map<string, { path: string; text: string }>) {}
	createObjectStore(): FakeStore { return new FakeStore(this.records); }
	transaction(): FakeTransaction {
		const transaction = new FakeTransaction(new FakeStore(this.records));
		queueMicrotask(() => transaction.oncomplete?.());
		return transaction;
	}
	close(): void {}
}

class FakeIndexedDb {
	readonly records = new Map<string, { path: string; text: string }>();
	private db: FakeDb | undefined;
	open(): IDBOpenDBRequest {
		const request = new FakeRequest<FakeDb>() as unknown as IDBOpenDBRequest & { result: FakeDb };
		queueMicrotask(() => {
			if (!this.db) {
				this.db = new FakeDb(this.records);
				request.result = this.db;
				(request as unknown as { onupgradeneeded: Callback }).onupgradeneeded?.();
			}
			request.result = this.db!;
			(request as unknown as { onsuccess: Callback }).onsuccess?.();
		});
		return request;
	}
}

test("browser storage round-trips JSON and isolates workspace paths", async () => {
	const indexedDB = new FakeIndexedDb();
	const storage = createBrowserStoragePort({ indexedDB, databaseName: "test-round-trip" });
	const path = storage.resolveDataPath("market-research-archive.json", "/browser");
	const otherPath = storage.resolveDataPath("market-research-archive.json", "/other");
	assert.notEqual(path, otherPath);
	assert.equal(await storage.readJsonFile(path), undefined);
	const value = { version: 1, entries: [{ symbol: "AAPL", blocks: ["read"] }] };
	await storage.writeJsonFileAtomic(path, value);
	assert.deepEqual(await storage.readJsonFile(path), value);
});

test("browser storage serializes before writing and rejects malformed JSON", async () => {
	const indexedDB = new FakeIndexedDb();
	const storage = createBrowserStoragePort({ indexedDB, databaseName: "test-errors" });
	const path = storage.resolveDataPath("archive.json");
	await storage.writeJsonFileAtomic(path, { old: true });
	const cyclic: Record<string, unknown> = {};
	cyclic.self = cyclic;
	await assert.rejects(storage.writeJsonFileAtomic(path, cyclic), TypeError);
	assert.deepEqual(await storage.readJsonFile(path), { old: true });
	indexedDB.records.set(path.replace("idb://market-terminal/", ""), { path: path.replace("idb://market-terminal/", ""), text: "{" });
	await assert.rejects(storage.readJsonFile(path), SyntaxError);
});
