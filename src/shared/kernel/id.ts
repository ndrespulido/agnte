/**
 * UUIDv7 (RFC 9562), generated wherever the entity is created.
 *
 * Two properties earn it over UUIDv4 (architecture.md §2). A Verse composed
 * offline gets its final id immediately, so there is no temporary id to remap
 * on sync. And the id sorts by creation time, which makes cursor pagination on
 * the timeline an index scan rather than a sort.
 *
 * Layout, 128 bits:
 *
 *   ┌────────────────────────┬──────┬──────────┬─────┬──────────────┐
 *   │ unix_ts_ms (48)        │ ver  │ rand_a   │ var │ rand_b (62)  │
 *   │                        │ (4)  │ (12)     │ (2) │              │
 *   └────────────────────────┴──────┴──────────┴─────┴──────────────┘
 *
 * rand_a is used as a monotonic counter rather than random bits — the method
 * RFC 9562 §6.2 calls "replace leftmost random bits with increased clock
 * precision". Without it, two ids minted in the same millisecond sort
 * arbitrarily, and a cursor paginating on id could skip or repeat a row at a
 * page boundary. That is the property the tests here are really protecting.
 *
 * Hand-written rather than taken from a package because the kernel has no
 * dependencies (§1), and because the monotonicity above is the part worth
 * owning and testing directly.
 *
 * Entropy comes from the Web Crypto `crypto` global rather than from
 * `node:crypto`, which is what lets the browser client mint its own ids. That
 * is not an incidental nicety: a Verse composed offline needs its final id
 * immediately (§8.1), and a second implementation in the client would be a
 * second set of monotonicity bugs to find.
 */

const MAX_COUNTER = 0xfff; // 12 bits of rand_a

let lastTimestamp = -1;
let counter = 0;

/**
 * A fresh millisecond starts the counter at a random point in its lower half.
 * Randomising it means two processes minting in the same millisecond are
 * unlikely to collide; keeping it in the lower half leaves room to increment
 * without overflowing.
 */
function seedCounter(): number {
  const bytes = crypto.getRandomValues(new Uint8Array(2));
  return ((bytes[0]! << 8) | bytes[1]!) & 0x7ff;
}

/**
 * @param now Millisecond timestamp. Injectable so tests can hold time still and
 *            exercise the same-millisecond path deliberately.
 */
export function uuidv7(now: number = Date.now()): string {
  if (now === lastTimestamp) {
    counter += 1;
    if (counter > MAX_COUNTER) {
      // More than 4096 ids in one millisecond. Rather than wrap the counter —
      // which would break ordering — treat the next millisecond as current.
      // Overshooting the wall clock by a millisecond is harmless; ids that no
      // longer sort by creation order are not.
      lastTimestamp = now + 1;
      counter = seedCounter();
      return build(lastTimestamp, counter);
    }
  } else if (now < lastTimestamp) {
    // The clock went backwards (NTP correction). Holding the previous timestamp
    // keeps ids monotonic at the cost of a slightly stale embedded time.
    counter += 1;
    if (counter > MAX_COUNTER) {
      lastTimestamp += 1;
      counter = seedCounter();
    }
    return build(lastTimestamp, counter);
  } else {
    lastTimestamp = now;
    counter = seedCounter();
  }

  return build(lastTimestamp, counter);
}

function build(timestamp: number, counterValue: number): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));

  // 48-bit big-endian timestamp.
  bytes[0] = (timestamp / 2 ** 40) & 0xff;
  bytes[1] = (timestamp / 2 ** 32) & 0xff;
  bytes[2] = (timestamp / 2 ** 24) & 0xff;
  bytes[3] = (timestamp / 2 ** 16) & 0xff;
  bytes[4] = (timestamp / 2 ** 8) & 0xff;
  bytes[5] = timestamp & 0xff;

  // Version 7 in the high nibble of byte 6, then the counter across the
  // remaining 12 bits of bytes 6-7.
  bytes[6] = 0x70 | ((counterValue >> 8) & 0x0f);
  bytes[7] = counterValue & 0xff;

  // RFC 4122 variant: top two bits of byte 8 set to 10.
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

/** The millisecond a UUIDv7 was minted at. */
export function timestampOf(id: string): number {
  const hex = id.replace(/-/g, '').slice(0, 12);
  return Number.parseInt(hex, 16);
}

const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export const isUuidV7 = (value: string): boolean => UUID_V7.test(value);

const UUID_ANY = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Any UUID, whatever version minted it.
 *
 * Narrower than `isUuidV7` on purpose: this is the question "can Postgres cast
 * this to `uuid`", which is what a value read out of a file has to answer
 * before it reaches a query. A v4 from somewhere else is a perfectly good
 * primary key; it just did not come from here.
 */
export const isUuid = (value: string): boolean => UUID_ANY.test(value);

/** Test seam: forget the monotonic state between cases. */
export function resetIdStateForTests(): void {
  lastTimestamp = -1;
  counter = 0;
}
