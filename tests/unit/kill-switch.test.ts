import { describe, expect, it } from 'vitest';
// @ts-expect-error -- plain ESM, deployed as a Cloud Function without types
import { decide, parseMessage } from '../../infra/kill-switch/decide.mjs';

/**
 * This function disables billing for the whole project. A false positive takes
 * everything down; a false negative makes the backstop useless. Both directions
 * are tested, including the shapes that should never act.
 */

const budget = (overrides: Record<string, unknown> = {}) => ({
  budgetDisplayName: 'agnte-agnte-prod',
  costAmount: 5,
  budgetAmount: 30,
  currencyCode: 'EUR',
  ...overrides,
});

describe('decide: does not act', () => {
  it('below the budget', () => {
    expect(decide(budget({ costAmount: 5 })).act).toBe(false);
  });

  it('at the roughly-EUR-20 alert, which fires on the same topic', () => {
    expect(decide(budget({ costAmount: 20 })).act).toBe(false);
  });

  it('just under the budget', () => {
    expect(decide(budget({ costAmount: 29.99 })).act).toBe(false);
  });

  it.each([
    ['null', null],
    ['a string', 'boom'],
    ['an empty object', {}],
    ['a missing costAmount', budget({ costAmount: undefined })],
    ['a missing budgetAmount', budget({ budgetAmount: undefined })],
    ['a string costAmount', budget({ costAmount: '99' })],
    ['NaN', budget({ costAmount: Number.NaN })],
    ['a zero budget', budget({ budgetAmount: 0 })],
    ['a negative budget', budget({ budgetAmount: -1 })],
  ])('on %s', (_label, message) => {
    expect(decide(message).act).toBe(false);
  });
});

describe('decide: acts', () => {
  it('exactly at the budget', () => {
    expect(decide(budget({ costAmount: 30 })).act).toBe(true);
  });

  it('over the budget', () => {
    const result = decide(budget({ costAmount: 31.5 }));
    expect(result.act).toBe(true);
    expect(result.reason).toContain('31.5');
    expect(result.reason).toContain('agnte-agnte-prod');
  });

  it('far over the budget', () => {
    expect(decide(budget({ costAmount: 5000 })).act).toBe(true);
  });
});

describe('parseMessage', () => {
  it('decodes the base64 payload Pub/Sub delivers', () => {
    const payload = budget({ costAmount: 42 });
    const data = {
      message: { data: Buffer.from(JSON.stringify(payload)).toString('base64') },
    };
    expect(parseMessage(data)).toEqual(payload);
  });

  it.each([
    ['no data', {}],
    ['a non-string payload', { message: { data: 123 } }],
    ['invalid base64 json', { message: { data: 'bm90IGpzb24=' } }],
    ['undefined', undefined],
  ])('returns undefined for %s', (_label, data) => {
    expect(parseMessage(data)).toBeUndefined();
  });

  it('an undecodable message therefore cannot act', () => {
    expect(decide(parseMessage({ message: { data: 'bm90IGpzb24=' } })).act).toBe(false);
  });
});
