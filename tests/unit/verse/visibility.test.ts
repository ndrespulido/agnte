import { describe, expect, it } from 'vitest';
import {
  DEFAULT_VISIBILITY,
  VISIBILITY_ORDER,
  atLeast,
  canRead,
  isVisibility,
  moreRestrictive,
  resolveVisibility,
  type Visibility,
} from '@/modules/verse';

/**
 * The rule these tests protect is the one CLAUDE.md says a single mis-tag must
 * not be able to break. So they are written to fail if the resolver is ever
 * changed to combine permissively — including exhaustively, over every
 * combination, rather than on a handful of chosen examples.
 */

const ALL = VISIBILITY_ORDER;

describe('resolveVisibility', () => {
  it('defaults to private with nothing to go on', () => {
    expect(resolveVisibility(null, [])).toBe('private');
    expect(DEFAULT_VISIBILITY).toBe('private');
  });

  it.each(ALL)('lets an explicit %s setting win over the tags', (explicit) => {
    // Every tag public, and the explicit setting still decides — including when
    // the explicit setting is the more permissive of the two.
    expect(resolveVisibility(explicit, ['public', 'public'])).toBe(explicit);
    expect(resolveVisibility(explicit, ['private', 'private'])).toBe(explicit);
  });

  it('inherits the single tag it has', () => {
    for (const v of ALL) expect(resolveVisibility(null, [v])).toBe(v);
  });

  it('takes the most restrictive tag, never the most permissive', () => {
    expect(resolveVisibility(null, ['public', 'private'])).toBe('private');
    expect(resolveVisibility(null, ['private', 'public'])).toBe('private');
    expect(resolveVisibility(null, ['public', 'shared'])).toBe('shared');
    expect(resolveVisibility(null, ['shared', 'public', 'private'])).toBe('private');
  });

  it('is exhaustively the minimum over every pair', () => {
    for (const a of ALL) {
      for (const b of ALL) {
        const expected = ALL.indexOf(a) <= ALL.indexOf(b) ? a : b;
        expect(resolveVisibility(null, [a, b])).toBe(expected);
      }
    }
  });

  it('is exhaustively the minimum over every triple, in any order', () => {
    for (const a of ALL) {
      for (const b of ALL) {
        for (const c of ALL) {
          const expected = [a, b, c].reduce((lo, v) =>
            ALL.indexOf(v) < ALL.indexOf(lo) ? v : lo,
          );
          expect(resolveVisibility(null, [a, b, c])).toBe(expected);
          expect(resolveVisibility(null, [c, b, a])).toBe(expected);
        }
      }
    }
  });

  it('the medical mis-tag case: one private tag buries a public one', () => {
    // The scenario CLAUDE.md names. A scan tagged .holiday because it was taken
    // on the trip must not become public because .holiday is.
    expect(resolveVisibility(null, ['public', 'private'])).toBe('private');
  });

  it('never resolves more permissively than its most restrictive input', () => {
    for (const a of ALL) {
      for (const b of ALL) {
        const resolved = resolveVisibility(null, [a, b]);
        expect(atLeast(a, resolved)).toBe(true);
        expect(atLeast(b, resolved)).toBe(true);
      }
    }
  });
});

describe('moreRestrictive', () => {
  it('is commutative and idempotent', () => {
    for (const a of ALL) {
      for (const b of ALL) {
        expect(moreRestrictive(a, b)).toBe(moreRestrictive(b, a));
      }
      expect(moreRestrictive(a, a)).toBe(a);
    }
  });

  it('private absorbs everything', () => {
    for (const v of ALL) expect(moreRestrictive('private', v)).toBe('private');
  });

  it('public is the identity', () => {
    for (const v of ALL) expect(moreRestrictive('public', v)).toBe(v);
  });
});

describe('isVisibility', () => {
  it('accepts exactly the three values', () => {
    for (const v of ALL) expect(isVisibility(v)).toBe(true);
  });

  it('rejects anything else, including near misses', () => {
    for (const v of ['Private', 'PUBLIC', 'shared ', '', 'protected', null, 7, {}]) {
      expect(isVisibility(v)).toBe(false);
    }
  });
});

describe('canRead', () => {
  const owner = 'owner-1';
  const other = 'viewer-2';

  it('lets the owner read their own verse at any visibility', () => {
    for (const effective of ALL) {
      expect(canRead({ ownerId: owner, viewerId: owner, effective })).toBe(true);
    }
  });

  it('lets anyone read a public verse, signed in or not', () => {
    expect(canRead({ ownerId: owner, viewerId: other, effective: 'public' })).toBe(true);
    expect(canRead({ ownerId: owner, viewerId: null, effective: 'public' })).toBe(true);
  });

  it('refuses a private verse to everyone but the owner', () => {
    expect(canRead({ ownerId: owner, viewerId: other, effective: 'private' })).toBe(
      false,
    );
    expect(canRead({ ownerId: owner, viewerId: null, effective: 'private' })).toBe(false);
  });

  it('does not treat shared as readable without an actual share', () => {
    // The leak this guards: "shared" means shared with named people, not with
    // anyone who happens to be signed in.
    expect(canRead({ ownerId: owner, viewerId: other, effective: 'shared' })).toBe(false);
    expect(
      canRead({
        ownerId: owner,
        viewerId: other,
        effective: 'shared',
        viewerHasShare: false,
      }),
    ).toBe(false);
    expect(
      canRead({
        ownerId: owner,
        viewerId: other,
        effective: 'shared',
        viewerHasShare: true,
      }),
    ).toBe(true);
  });

  it('a share does not open a private verse', () => {
    // A share on one tag must not reach a verse another tag made private.
    expect(
      canRead({
        ownerId: owner,
        viewerId: other,
        effective: 'private',
        viewerHasShare: true,
      }),
    ).toBe(false);
  });

  it('an anonymous viewer is never the owner, even with a null owner id', () => {
    // Guards the shape of the identity check: `null === null` would hand an
    // anonymous viewer ownership of any row whose owner failed to load.
    expect(
      canRead({
        ownerId: null as unknown as string,
        viewerId: null,
        effective: 'private',
      }),
    ).toBe(false);
  });
});

describe('the visibility scale', () => {
  it('is ordered most restrictive first', () => {
    // The order is the semantics: resolve is a minimum over this array, so a
    // reordering here silently inverts the rule. Pinned deliberately.
    expect(ALL).toEqual(['private', 'shared', 'public'] satisfies Visibility[]);
  });
});
