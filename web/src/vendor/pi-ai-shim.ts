/**
 * Browser shim for @earendil-works/pi-ai (stage 2a loadability spike).
 *
 * The extension's only runtime import from pi-ai is `StringEnum`
 * (market-terminal.ts:1). The real package's index re-exports typebox
 * helpers plus a large SDK surface that drags in Node-only modules
 * (oauth, env-api-keys, ...). This shim forwards StringEnum to the vendored
 * port and re-exports types so type-only imports keep resolving.
 */

export { StringEnum } from "./pi-ai-string-enum.js";
export type { TUnsafe } from "typebox";
