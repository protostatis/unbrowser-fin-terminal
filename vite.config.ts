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

// Determine build mode from PUBLIC_BASE_PATH: if the path contains the
// "fin-terminal-demo" segment the build is for replay-only kiosk mode;
// otherwise it is a live agent build.
const buildMode: "replay" | "live" = publicBasePath.split("/").filter(Boolean).includes("fin-terminal-demo")
  ? "replay"
  : "live";

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
    proxy: {
      "/api": { target: backendHttp, changeOrigin: true },
      "/ws": { target: backendWs, ws: true, changeOrigin: true },
    },
  },
  build: { outDir: "../dist-web", emptyOutDir: true },
});
