import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath, URL } from "node:url";

// Dev: the React app proxies /api and /ws to the Node backend (server/index.ts).
const backendPort = Number(process.env.MARKET_SERVER_PORT ?? process.env.PORT ?? 8787);
const backendHttp = `http://127.0.0.1:${backendPort}`;
const backendWs = `ws://127.0.0.1:${backendPort}`;
const yahooHttp = "https://query1.finance.yahoo.com";
const publicBasePath = process.env.PUBLIC_BASE_PATH?.trim() || "/";
if (!/^\/(?:[A-Za-z0-9._~-]+\/)*$/.test(publicBasePath)) {
  throw new Error("PUBLIC_BASE_PATH must start and end with / and contain URL-safe path segments");
}

// Legacy builds infer replay mode from the public-demo path. A public live
// gateway keeps that stable URL but explicitly builds the real client with
// VITE_TERMINAL_BUILD_MODE=public-live. Normalize empty/whitespace to
// undefined so the path-based default applies (the Dockerfile passes an empty
// VITE_TERMINAL_BUILD_MODE, which ?? alone would treat as a valid value).
const requestedBuildMode = process.env.VITE_TERMINAL_BUILD_MODE?.trim() || undefined;
if (requestedBuildMode && !["replay", "live", "public-live", "browser"].includes(requestedBuildMode)) {
  throw new Error("VITE_TERMINAL_BUILD_MODE must be replay, live, public-live, or browser");
}
const buildMode: "replay" | "live" | "public-live" | "browser" = requestedBuildMode as
  | "replay"
  | "live"
  | "public-live"
  | "browser"
  | undefined
  ?? (publicBasePath.split("/").filter(Boolean).includes("fin-terminal-demo") ? "replay" : "live");
const baseProxyPath = publicBasePath === "/" ? "" : publicBasePath.replace(/\/$/, "");
const proxy = {
  "/api": { target: backendHttp, changeOrigin: true },
  "/ws": { target: backendWs, ws: true, changeOrigin: true },
  // Yahoo rejects browser-like requests from this environment with HTTP 429
  // and does not expose a stable CORS contract. Keep the browser alpha's dev
  // path same-origin, while leaving production deployments responsible for
  // supplying an explicit quote transport.
  "/yahoo": {
    target: yahooHttp,
    changeOrigin: true,
    headers: { "user-agent": "signal-terminal-mvp/0.1" },
    rewrite: (requestPath: string) => requestPath.replace(/^\/yahoo/, ""),
  },
  ...(baseProxyPath ? {
    [`${baseProxyPath}/api`]: {
      target: backendHttp,
      changeOrigin: true,
      rewrite: (requestPath: string) => requestPath.slice(baseProxyPath.length),
    },
    [`${baseProxyPath}/ws`]: {
      target: backendWs,
      ws: true,
      changeOrigin: true,
      rewrite: (requestPath: string) => requestPath.slice(baseProxyPath.length),
    },
  } : {}),
};

export default defineConfig({
  root: "web",
  base: publicBasePath,
  plugins: [
    react(),
    {
      name: "inject-build-mode",
      transformIndexHtml(html) {
        return html.replace(
          "</head>",
          `  <meta name="x-build-mode" content="${buildMode}">\n  <meta name="x-build-base-path" content="${publicBasePath}">\n  </head>`,
        );
      },
    },
  ],
  resolve: {
    alias: [
      { find: "node:crypto", replacement: fileURLToPath(new URL("./web/src/harness/browser-shims.ts", import.meta.url)) },
      { find: "node:fs/promises", replacement: fileURLToPath(new URL("./web/src/harness/node-fs-stub.ts", import.meta.url)) },
      { find: "node:fs", replacement: fileURLToPath(new URL("./web/src/harness/node-fs-stub.ts", import.meta.url)) },
      { find: "node:path", replacement: fileURLToPath(new URL("./web/src/harness/node-path-shim.ts", import.meta.url)) },
      { find: "node:child_process", replacement: fileURLToPath(new URL("./web/src/harness/node-child-process-stub.ts", import.meta.url)) },
      { find: "node:url", replacement: fileURLToPath(new URL("./web/src/harness/node-url-shim.ts", import.meta.url)) },
      { find: "@earendil-works/pi-tui", replacement: fileURLToPath(new URL("./web/src/vendor/pi-tui-utils.ts", import.meta.url)) },
      { find: "@earendil-works/pi-ai", replacement: fileURLToPath(new URL("./web/src/vendor/pi-ai-shim.ts", import.meta.url)) },
      { find: "@earendil-works/pi-coding-agent", replacement: fileURLToPath(new URL("./web/src/vendor/pi-coding-agent-shim.ts", import.meta.url)) },
    ],
  },
  define: {
    process: "globalThis.__browserProcess",
    Buffer: "globalThis.__browserBuffer",
  },
  // The isolated research worker imports shared chunks. Vite's default IIFE
  // worker format cannot represent that code-split graph. The shared hash
  // adapter also uses a dynamic node:crypto import, so keep the browser graph
  // in ESNext rather than asking esbuild to lower top-level await.
  worker: { format: "es" },
  server: {
    port: 5173,
    proxy,
  },
  build: {
    outDir: "../dist-web",
    emptyOutDir: true,
    target: "esnext",
  },
});
