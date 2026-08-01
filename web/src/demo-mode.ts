/**
 * Public demo deployment detection.
 *
 * The demo build is compiled with PUBLIC_BASE_PATH=/unbrowser/fin-terminal-demo/,
 * so Vite's BASE_URL ends with the demo subpath. The authenticated production
 * build never contains it. This drives the waiting-room overlay and the demo
 * banner without any runtime configuration.
 */
export const PUBLIC_DEMO =
  import.meta.env.BASE_URL !== "/" &&
  import.meta.env.BASE_URL.includes("fin-terminal-demo");
