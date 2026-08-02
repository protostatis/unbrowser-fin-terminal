import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

const ID_PATTERN = /^[A-Za-z0-9_-]{16,160}$/;

/** Generate an opaque, URL-safe identifier without embedding visitor data. */
export function createOpaqueId(bytes = 24): string {
  if (!Number.isInteger(bytes) || bytes < 16 || bytes > 64) {
    throw new Error("opaque id byte length must be an integer from 16 to 64");
  }
  return randomBytes(bytes).toString("base64url");
}

/**
 * Sign an opaque browser-held identifier. The identifier is still checked
 * against gateway state, so a valid stale token cannot revive a seat.
 */
export function signOpaqueId(id: string, signingKey: string): string {
  if (!ID_PATTERN.test(id)) throw new Error("opaque id has an invalid format");
  const signature = createHmac("sha256", signingKey).update(id).digest("base64url");
  return `${id}.${signature}`;
}

/** Return a verified identifier or undefined without leaking signature details. */
export function verifyOpaqueId(token: string | undefined, signingKey: string): string | undefined {
  if (!token) return undefined;
  const separator = token.lastIndexOf(".");
  if (separator <= 0 || separator === token.length - 1) return undefined;
  const id = token.slice(0, separator);
  const supplied = token.slice(separator + 1);
  if (!ID_PATTERN.test(id) || !/^[A-Za-z0-9_-]{32,128}$/.test(supplied)) return undefined;
  const expected = createHmac("sha256", signingKey).update(id).digest("base64url");
  const actualBuffer = Buffer.from(supplied);
  const expectedBuffer = Buffer.from(expected);
  if (actualBuffer.length !== expectedBuffer.length) return undefined;
  return timingSafeEqual(actualBuffer, expectedBuffer) ? id : undefined;
}
