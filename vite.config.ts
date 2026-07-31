import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Dev: the React app proxies /api and /ws to the Node backend (server/index.ts).
const backendPort = Number(process.env.MARKET_SERVER_PORT ?? process.env.PORT ?? 8787);
const backendHttp = `http://127.0.0.1:${backendPort}`;
const backendWs = `ws://127.0.0.1:${backendPort}`;

export default defineConfig({
  root: "web",
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
