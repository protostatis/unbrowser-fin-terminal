import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Dev: the React app proxies /api and /ws to the Node backend (server/index.ts).
const backendPort = Number(process.env.MARKET_SERVER_PORT ?? process.env.PORT ?? 8787);
const backendHttp = `http://127.0.0.1:${backendPort}`;
const backendWs = `ws://127.0.0.1:${backendPort}`;
const publicBasePath = process.env.PUBLIC_BASE_PATH?.trim() || "/";
if (!/^\/(?:[A-Za-z0-9._~-]+\/)*$/.test(publicBasePath)) {
  throw new Error("PUBLIC_BASE_PATH must start and end with / and contain URL-safe path segments");
}

// Legacy builds infer replay mode from the public-demo path. A public live
// gateway keeps that stable URL but explicitly builds the real client with
// VITE_TERMINAL_BUILD_MODE=public-live.
const requestedBuildMode = process.env.VITE_TERMINAL_BUILD_MODE?.trim();
if (requestedBuildMode && !["replay", "live", "public-live"].includes(requestedBuildMode)) {
  throw new Error("VITE_TERMINAL_BUILD_MODE must be replay, live, or public-live");
}
const buildMode: "replay" | "live" | "public-live" = requestedBuildMode as
  | "replay"
  | "live"
  | "public-live"
  | undefined
  ?? (publicBasePath.split("/").filter(Boolean).includes("fin-terminal-demo") ? "replay" : "live");
const baseProxyPath = publicBasePath === "/" ? "" : publicBasePath.replace(/\/$/, "");
const proxy = {
  "/api": { target: backendHttp, changeOrigin: true },
  "/ws": { target: backendWs, ws: true, changeOrigin: true },
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
          `  <meta name="x-build-mode" content="${buildMode}">\n  </head>`,
        );
      },
    },
  ],
  server: {
    port: 5173,
    proxy,
  },
  build: { outDir: "../dist-web", emptyOutDir: true },
});
