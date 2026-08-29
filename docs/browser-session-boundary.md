# Browser session boundary

The browser session is a private alpha, not a replacement for the public
gateway.

## Browser alpha

Run with `VITE_SESSION_MODE=browser`. It loads the canonical
`.pi/extensions/market-terminal.ts` through a browser-compatible host and runs
one research attempt per Web Worker. The OpenRouter key is BYOK and remains in
the connected tab's memory only. Reloading or disconnecting clears it. Scout,
pre-cache, and local CLI execution are disabled.

Completed research archives use IndexedDB under a virtual path. IndexedDB is
local browser persistence, not a shared workspace or a server checkpoint. A
whole-runtime Web Lock prevents two tabs from concurrently opening a writable
session for the same archive.

The browser requires a CORS-capable Unbrowser MCP endpoint configured with
`VITE_UNBROWSER_MCP_URL` for source discovery/extraction. The browser must not
silently fall back to the local `unbrowser` executable. Yahoo quote requests
are likewise subject to browser CORS policy unless the deployment supplies an
explicit, authenticated quote transport.

## Node/Pi runtime

The default build and signed-in live path remain Node-side. Pi owns the
filesystem, child processes, session transcript, and the canonical extension
execution environment. `createNodeKernelPorts()` remains the default when Pi
loads the extension.

## Public gateway

The anonymous `public-gateway` continues to admit a bounded disposable Node Pi
worker through Turnstile, rate limits, leases, permits, and tombstones. Its
terminal protocol accepts only bounded input, resize, `/market` command,
select-response, and approved web-action messages. It must never accept or
forward a visitor's OpenRouter API key, authorization header, model selection,
or direct tool request. Worker frames are also checked for credential-like
fields before they reach the browser.

The browser alpha must not be enabled as the anonymous public gateway. If it is
ever promoted beyond personal use, add authentication, quota enforcement,
source-proxy abuse controls, browser compatibility coverage, and a versioned
multi-writer persistence design first.
