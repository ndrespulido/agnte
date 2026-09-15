import { beforeEach, describe, expect, it } from 'vitest';
import {
  derivedUuidv7,
  isUuid,
  isUuidV7,
  resetIdStateForTests,
  timestampOf,
  uuidv7,
} from '@/shared/kernel/id';

beforeEach(resetIdStateForTests);

describe('format', () => {
  it('is a valid UUIDv7 — version 7 nibble and RFC 4122 variant', () => {
    for (let i = 0; i < 200; i += 1) {
      expect(isUuidV7(uuidv7())).toBe(true);
    }
  });

  it('embeds the timestamp it was minted at', () => {
    const now = 1_767_225_600_000; // 2026-01-01T00:00:00Z
    expect(timestampOf(uuidv7(now))).toBe(now);
  });

  it('handles timestamps above 2^32 ms, which a naive shift would truncate', () => {
    const farFuture = 4_102_444_800_000; // 2100-01-01
    expect(timestampOf(uuidv7(farFuture))).toBe(farFuture);
  });
});

describe('uniqueness', () => {
  it('does not repeat across many ids in the same millisecond', () => {
    const ids = new Set<string>();
    for (let i = 0; i < 4000; i += 1) ids.add(uuidv7(1_767_225_600_000));
    expect(ids.size).toBe(4000);
  });

  it('does not repeat across real time', () => {
    const ids = new Set<string>();
    for (let i = 0; i < 5000; i += 1) ids.add(uuidv7());
    expect(ids.size).toBe(5000);
  });
});

/**
 * The property the timeline depends on. Cursor pagination orders by id, so two
 * ids minted in the same millisecond sorting arbitrarily would let a page
 * boundary skip or repeat a row.
 */
describe('monotonicity', () => {
  it('sorts lexicographically in creation order within one millisecond', () => {
    const ids = Array.from({ length: 2000 }, () => uuidv7(1_767_225_600_000));
    expect([...ids].sort()).toEqual(ids);
  });

  it('sorts lexicographically in creation order across milliseconds', () => {
    const ids: string[] = [];
    for (let ms = 0; ms < 50; ms += 1) {
      for (let i = 0; i < 20; i += 1) ids.push(uuidv7(1_767_225_600_000 + ms));
    }
    expect([...ids].sort()).toEqual(ids);
  });

  it('stays ordered when the counter overflows a single millisecond', () => {
    // More than the 4096 the 12-bit counter holds, forcing the spill path.
    const ids = Array.from({ length: 9000 }, () => uuidv7(1_767_225_600_000));
    expect([...ids].sort()).toEqual(ids);
    expect(new Set(ids).size).toBe(9000);
  });

  it('stays ordered when the clock goes backwards', () => {
    const base = 1_767_225_600_000;
    const ids = [
      uuidv7(base),
      uuidv7(base + 5),
      uuidv7(base - 1000), // an NTP correction
      uuidv7(base - 999),
      uuidv7(base + 6),
    ];
    expect([...ids].sort()).toEqual(ids);
    expect(new Set(ids).size).toBe(5);
  });

  it('orders by real time when generated normally', async () => {
    const first = uuidv7();
    await new Promise((resolve) => setTimeout(resolve, 3));
    const second = uuidv7();
    expect(first < second).toBe(true);
    expect(timestampOf(second)).toBeGreaterThan(timestampOf(first));
  });
});

describe('isUuidV7', () => {
  it.each([
    ['a UUIDv4', '9f1c8a2e-4b6d-4c3a-8f21-0b3d5e7a9c11'],
    ['an empty string', ''],
    ['not a uuid', 'not-a-uuid'],
    ['a wrong variant', '0194f3a0-0000-7000-0000-000000000000'],
    ['uppercase', '0194F3A0-0000-7000-8000-000000000000'],
  ])('rejects %s', (_label, value) => {
    expect(isUuidV7(value)).toBe(false);
  });
});

describe('isUuid', () => {
  it('accepts any version, and either case', () => {
    expect(isUuid(uuidv7())).toBe(true);
    expect(isUuid('9f1c8a2e-4b6d-4c3a-8f21-0b3d5e7a9c11')).toBe(true);
    expect(isUuid('9F1C8A2E-4B6D-4C3A-8F21-0B3D5E7A9C11')).toBe(true);
  });

  it.each([
    ['an empty string', ''],
    ['a v1-style id', 'clh3x8k2p0000qwer1234asdf'],
    ['a uuid with a missing group', '9f1c8a2e-4b6d-4c3a-0b3d5e7a9c11'],
    ["postgres' own idea of a cast", "'x'::uuid"],
  ])('rejects %s', (_label, value) => {
    expect(isUuid(value)).toBe(false);
  });
});

/**
 * The property the import rests on: same inputs, same id, every time. Without
 * it a second import of the same file writes a second copy of every row it
 * could not import under its original id.
 */
describe('derivedUuidv7', () => {
  const owner = '0194f3a0-1111-7000-8000-000000000001';
  const other = '0194f3a0-1111-7000-8000-000000000002';
  const source = '0194f3a0-2222-7000-8000-0000000000aa';

  it('is stable for the same namespace and source', () => {
    expect(derivedUuidv7(owner, source)).toBe(derivedUuidv7(owner, source));
  });

  it('differs per namespace, so two accounts importing one file do not collide', () => {
    expect(derivedUuidv7(owner, source)).not.toBe(derivedUuidv7(other, source));
  });

  it('differs per source', () => {
    expect(derivedUuidv7(owner, source)).not.toBe(derivedUuidv7(owner, `${source}x`));
  });

  it('is a well-formed UUIDv7', () => {
    expect(isUuidV7(derivedUuidv7(owner, source))).toBe(true);
    expect(isUuidV7(derivedUuidv7(owner, 'clh3x8k2p0000qwer1234asdf'))).toBe(true);
  });

  /**
   * An imported timeline keeps the order it had at home. Ids are the tiebreak
   * in the timeline's index, so a derived id that landed at a random point in
   * time would shuffle rows that share a date.
   */
  it('keeps the source timestamp when the source is a UUIDv7', () => {
    const at = Date.UTC(2026, 4, 17, 9, 30);
    expect(timestampOf(derivedUuidv7(owner, uuidv7(at)))).toBe(at);
  });

  it('never returns the source id itself', () => {
    expect(derivedUuidv7(owner, source)).not.toBe(source);
  });
});
