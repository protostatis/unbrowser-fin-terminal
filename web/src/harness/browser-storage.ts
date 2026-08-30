/**
 * IndexedDB implementation of the kernel's JSON-file StoragePort.
 *
 * The extension deliberately continues to speak in virtual file paths. The
 * browser adapter maps those paths to one IndexedDB record and stores JSON
 * text, preserving Node's stringify/parse behavior instead of relying on
 * structured cloning.
 */
import type { StoragePort } from "../../../shared/kernel/ports.js";
import { browserApiUrl } from "./browser-api.js";

export const BROWSER_STORAGE_DB = "unbrowser-fin-terminal";
export const BROWSER_STORAGE_VERSION = 1;
export const BROWSER_STORAGE_STORE = "files";
const VIRTUAL_PREFIX = "idb://market-terminal/";

interface StoredFile {
	path: string;
	text: string;
}

export interface BrowserIndexedDbLike {
	open(name: string, version?: number): IDBOpenDBRequest;
}

export interface BrowserStorageOptions {
	indexedDB?: BrowserIndexedDbLike;
	databaseName?: string;
}

function indexedDb(options: BrowserStorageOptions): BrowserIndexedDbLike {
	const value = options.indexedDB ?? (globalThis as typeof globalThis & { indexedDB?: BrowserIndexedDbLike }).indexedDB;
	if (!value) throw new Error("IndexedDB is unavailable; browser archive persistence is disabled");
	return value;
}

function normalizeRelativePath(relative: string): string {
	if (typeof relative !== "string" || relative.length === 0 || relative.length > 240) {
		throw new Error("Browser storage path is invalid");
	}
	if (relative.startsWith("/") || relative.includes("\\")) throw new Error("Browser storage path must be relative");
	const parts = relative.split("/");
	if (parts.some((part) => !part || part === "." || part === "..")) throw new Error("Browser storage path contains an invalid segment");
	return parts.join("/");
}

function workspaceKey(cwd: string | undefined): string {
	const value = (cwd ?? "/browser").trim() || "/browser";
	return value.replace(/[\u0000\u0001-\u001f\u007f]/g, "").slice(0, 240) || "/browser";
}

function keyForPath(path: string): string {
	if (!path.startsWith(VIRTUAL_PREFIX)) throw new Error("Browser storage only accepts virtual IndexedDB paths");
	return path.slice(VIRTUAL_PREFIX.length);
}

function openDatabase(dbApi: BrowserIndexedDbLike, name: string): Promise<IDBDatabase> {
	return new Promise((resolve, reject) => {
		const request = dbApi.open(name, BROWSER_STORAGE_VERSION);
		request.onupgradeneeded = () => {
			const db = request.result;
			if (!db.objectStoreNames.contains(BROWSER_STORAGE_STORE)) db.createObjectStore(BROWSER_STORAGE_STORE, { keyPath: "path" });
		};
		request.onsuccess = () => resolve(request.result);
		request.onerror = () => reject(request.error ?? new Error("Could not open browser archive storage"));
		request.onblocked = () => reject(new Error("Browser archive storage upgrade is blocked by another tab"));
	});
}

function closeAfter<T>(db: IDBDatabase, promise: Promise<T>): Promise<T> {
	return promise.finally(() => db.close());
}

export function createBrowserStoragePort(options: BrowserStorageOptions = {}): StoragePort {
	const dbApi = indexedDb(options);
	const databaseName = options.databaseName ?? BROWSER_STORAGE_DB;
	return {
		resolveDataPath(relative: string, baseCwd?: string): string {
			return `${VIRTUAL_PREFIX}${encodeURIComponent(workspaceKey(baseCwd))}/${normalizeRelativePath(relative)}`;
		},
		async readJsonFile(path: string): Promise<unknown | undefined> {
			const db = await openDatabase(dbApi, databaseName);
			const result = new Promise<unknown | undefined>((resolve, reject) => {
				const transaction = db.transaction(BROWSER_STORAGE_STORE, "readonly");
				const request = transaction.objectStore(BROWSER_STORAGE_STORE).get(keyForPath(path));
				request.onsuccess = () => {
					const record = request.result as StoredFile | undefined;
					if (!record) {
						resolve(undefined);
						return;
					}
					// JSON.parse errors intentionally reject like the Node port.
					try {
						resolve(JSON.parse(record.text));
					} catch (error) {
						reject(error);
					}
				};
				request.onerror = () => reject(request.error ?? new Error("Could not read browser archive storage"));
				transaction.onerror = () => reject(transaction.error ?? new Error("Could not read browser archive storage"));
			});
			return closeAfter(db, result);
		},
		async writeJsonFileAtomic(path: string, value: unknown): Promise<void> {
			// Serialize before opening the transaction, matching Node's failure
			// behavior for cyclic values and BigInt without a partial write.
			const text = `${JSON.stringify(value, null, 2)}\n`;
			const db = await openDatabase(dbApi, databaseName);
			const result = new Promise<void>((resolve, reject) => {
				const transaction = db.transaction(BROWSER_STORAGE_STORE, "readwrite");
				transaction.objectStore(BROWSER_STORAGE_STORE).put({ path: keyForPath(path), text } satisfies StoredFile);
				transaction.oncomplete = () => resolve();
				transaction.onerror = () => reject(transaction.error ?? new Error("Could not write browser archive storage"));
				transaction.onabort = () => reject(transaction.error ?? new Error("Browser archive write was aborted"));
			});
			return closeAfter(db, result);
		},
	};
}

/** In-memory equivalent used by isolated research workers and unit tests. */
export function createMemoryStoragePort(): StoragePort {
	const files = new Map<string, string>();
	return {
		resolveDataPath: (relative, baseCwd = "/browser") => `${VIRTUAL_PREFIX}${encodeURIComponent(workspaceKey(baseCwd))}/${normalizeRelativePath(relative)}`,
		async readJsonFile(path) {
			const text = files.get(keyForPath(path));
			return text === undefined ? undefined : JSON.parse(text);
		},
		async writeJsonFileAtomic(path, value) {
			files.set(keyForPath(path), `${JSON.stringify(value, null, 2)}\n`);
		},
	};
}

/**
 * Principal-scoped storage for the authenticated browser terminal. The server
 * owns the durable record; this adapter keeps the kernel's virtual-file
 * contract and its latest ETag without ever placing credentials in storage.
 */
export function createBrowserHttpStoragePort(options: { fetchImpl?: typeof fetch } = {}): StoragePort {
	const request = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
	const etags = new Map<string, string | null>();
	const pathName = (path: string): "market-research-archive.json" | "market-watchlist.json" => {
		const name = path.startsWith("browser-http://storage/") ? path.slice("browser-http://storage/".length) : path;
		if (name !== "market-research-archive.json" && name !== "market-watchlist.json") {
			throw new Error("Authenticated browser storage path is not supported");
		}
		return name;
	};
	const storageUrl = (path: string): string => browserApiUrl(`/api/browser/v1/storage/${encodeURIComponent(pathName(path))}`);

	return {
		resolveDataPath(relative: string): string {
			if (relative !== "market-research-archive.json" && relative !== "market-watchlist.json") {
				throw new Error("Authenticated browser storage path is not supported");
			}
			return `browser-http://storage/${relative}`;
		},
		async readJsonFile(path: string): Promise<unknown | undefined> {
			const name = pathName(path);
			const response = await request(storageUrl(path), { headers: { accept: "application/json" } });
			if (response.status === 404) {
				etags.set(name, null);
				return undefined;
			}
			if (!response.ok) throw new Error(`browser storage read returned HTTP ${response.status}`);
			const etag = response.headers.get("etag");
			if (!etag) throw new Error("Authenticated browser storage read did not return an ETag");
			etags.set(name, etag);
			return await response.json();
		},
		async writeJsonFileAtomic(path: string, value: unknown): Promise<void> {
			const name = pathName(path);
			const headers: Record<string, string> = { "content-type": "application/json", accept: "application/json" };
			if (!etags.has(name)) throw new Error("Authenticated browser storage must be read before it can be written");
			const etag = etags.get(name);
			if (etag) headers["if-match"] = etag;
			else headers["if-none-match"] = "*";
			const response = await request(storageUrl(path), {
				method: "PUT",
				headers,
				body: JSON.stringify(value),
			});
			if (response.status === 409 || response.status === 412) throw new Error("Authenticated browser storage changed in another tab; reload to reconcile it");
			if (!response.ok) throw new Error(`browser storage write returned HTTP ${response.status}`);
			const nextEtag = response.headers.get("etag");
			if (!nextEtag) throw new Error("Authenticated browser storage write did not return an ETag");
			etags.set(name, nextEtag);
		},
	};
}
