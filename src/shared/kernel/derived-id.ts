import { createHash } from 'node:crypto';
import { isUuidV7 } from './id';

/**
 * A UUIDv7 derived from a namespace and a source string rather than minted.
 *
 * The one place this is for: importing rows whose ids are already taken. A
 * random replacement would be a different id on every run, so importing the
 * same file twice would write a second copy instead of recognising the first.
 * Deriving it means the same source id, imported into the same account, always
 * lands on the same row — which is what makes an import idempotent without a
 * table of what-became-what.
 *
 * The random half is `sha256(namespace + source)` — stable, and not reversible
 * into the namespace by someone holding the source id. The timestamp half is
 * copied from the source when the source is itself a UUIDv7, so an imported
 * timeline keeps the id order it had at home; a source id of any other shape
 * has no timestamp to keep and takes hash bytes there too.
 *
 * Not a UUIDv5. That is the standard answer for "deterministic id", but it
 * would be the one id in the system that does not sort by time, and the
 * ordering is load-bearing (see above).
 *
 * Lives apart from `id.ts` because it is the one id function that cannot run
 * in a browser: SHA-256 is only available there asynchronously, through
 * SubtleCrypto. Keeping `node:crypto` out of `id.ts` is what lets the client
 * import `uuidv7` for an offline write (§8.1); importing this file from the
 * client would drag Node's crypto into the browser bundle.
 */
export function derivedUuidv7(namespace: string, source: string): string {
  const bytes = createHash('sha256')
    .update(`${namespace}:${source}`)
    .digest()
    .subarray(0, 16);

  if (isUuidV7(source)) {
    Buffer.from(source.replace(/-/g, '').slice(0, 12), 'hex').copy(bytes, 0);
  }

  bytes[6] = (bytes[6]! & 0x0f) | 0x70;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;

  return format(bytes);
}

/** The 8-4-4-4-12 form, from sixteen bytes. */
function format(bytes: Uint8Array): string {
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join('-');
}
