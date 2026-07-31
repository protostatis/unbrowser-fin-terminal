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

export default defineConfig({
  root: "web",
  base: publicBasePath,
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/api": { target: backendHttp, changeOrigin: true },
      "/ws": { target: backendWs, ws: true, changeOrigin: true },
    },
  },
  build: { outDir: "../dist-web", emptyOutDir: true },
});
