/**
 * Type-only shim for @earendil-works/pi-coding-agent (stage 2a loadability
 * spike). The extension imports only types from this package
 * (market-terminal.ts:2); the runtime implementation is the
 * BrowserExtensionHost in web/src/harness/extension-loadability.ts.
 */

export type { ExtensionAPI, ExtensionCommandContext, ExtensionContext, SessionStartEvent, Theme } from "@earendil-works/pi-coding-agent";
