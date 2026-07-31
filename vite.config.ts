import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Dev: the React app proxies /api and /ws to the Node backend (server/index.ts).
export default defineConfig({
  root: "web",
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/api": { target: "http://localhost:8787", changeOrigin: true },
      "/ws": { target: "ws://localhost:8787", ws: true, changeOrigin: true },
    },
  },
  build: { outDir: "../dist-web", emptyOutDir: true },
});
