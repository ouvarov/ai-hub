/**
 * Base64 ↔ ArrayBuffer helpers safe for large payloads on Cloudflare Workers.
 *
 * The naive `String.fromCharCode(...bytes)` form blows the V8 argument limit
 * (~100k entries) on multi-MiB buffers. The chunked variant below builds the
 * binary string in slices and survives ≥10 MiB payloads.
 *
 * Used by the image, figma, and gdrive actions.
 */

const CHUNK = 0x8000;

/** Encode any ArrayBuffer or Uint8Array as a standard (not URL-safe) base64 string. */
export function bufferToBase64(buf: ArrayBuffer | Uint8Array): string {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let binary = "";
  for (let i = 0; i < bytes.length; i += CHUNK) {
    const end = Math.min(i + CHUNK, bytes.length);
    binary += String.fromCharCode.apply(
      null,
      bytes.subarray(i, end) as unknown as number[],
    );
  }
  return btoa(binary);
}

/** Decode a standard base64 string into an ArrayBuffer. Whitespace inside the input is stripped. */
export function base64ToBuffer(b64: string): ArrayBuffer {
  const clean = b64.replace(/\s+/g, "");
  const binary = atob(clean);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

/** Encode an ArrayBuffer as base64url (no padding, `-` and `_` instead of `+` and `/`). */
export function bufferToBase64Url(buf: ArrayBuffer | Uint8Array): string {
  return bufferToBase64(buf)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}
