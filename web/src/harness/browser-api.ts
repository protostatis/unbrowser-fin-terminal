/** Same-origin URL helpers shared by authenticated browser transports. */

export function browserApiUrl(path: string): string {
	const viteEnv = (import.meta as ImportMeta & { env?: Record<string, string | undefined> }).env;
	const base = viteEnv?.BASE_URL && viteEnv.BASE_URL !== "/"
		? viteEnv.BASE_URL.replace(/\/$/, "")
		: "";
	return new URL(`${base}${path}`, globalThis.location?.origin ?? "http://localhost").href;
}
