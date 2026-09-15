import { type Tag, format } from './tag';
import type { Verse } from './verse';
import { MAX_RATING, MIN_RATING } from './verse';

/**
 * What a tag's dashboard says about the verses in it.
 *
 * Pure, and deliberately so: this is the "query it like a database" half of the
 * pitch (CLAUDE.md), and the arithmetic behind a number someone will read as
 * "I spent €840 in Barcelona" should be testable without a database, a clock or
 * a framework.
 *
 * It takes verses that have *already* been filtered to what the viewer may see.
 * That is not an implementation detail to be optimised away later: aggregating
 * in SQL would mean a second visibility predicate, and architecture.md §2 says
 * that rule lives in exactly one place and every read path — "timeline, tag
 * filter, search, dashboard, export" — goes through it. A dashboard that
 * counted rows the reader cannot open would disclose their existence, which is
 * the whole failure this module is built to prevent. So the cost is paid here:
 * rows are read, filtered, and only then counted.
 */

/** A property key, and what its values add up to when they are numbers. */
export interface PropertySummary {
  readonly key: string;
  /** How many verses carry this key at all. */
  readonly verseCount: number;
  /**
   * How many of those values parsed as a number.
   *
   * Reported next to `sum` rather than folded into it, because the difference
   * matters: a total over 9 of 12 values is a different fact from a total over
   * all 12, and silently presenting the first as the second is how a dashboard
   * becomes confidently wrong. The UI shows the gap when there is one.
   */
  readonly numericCount: number;
  /** Null when nothing parsed — not 0, which would read as "they sum to zero". */
  readonly sum: number | null;
}

/** Another tag that appears on the same verses, and how often. */
export interface CoTagSummary {
  readonly id: string;
  readonly name: string;
  readonly label: string;
  readonly count: number;
}

export interface TagSummary {
  readonly verseCount: number;

  /** Earliest and latest `eventStart` among calendar-dated verses. */
  readonly firstEvent: Date | null;
  readonly lastEvent: Date | null;

  /** Verses with no date at all — legitimate: a minimal Verse is media + a tag. */
  readonly undatedCount: number;
  /** Verses placed by `deepTimeYears` instead, which no calendar span covers. */
  readonly deepTimeCount: number;

  readonly ratedCount: number;
  /** Null when nothing is rated, for the same reason `sum` is. */
  readonly averageRating: number | null;
  /** Index 0..10, counting verses at each rating. */
  readonly ratingHistogram: readonly number[];

  readonly withMediaCount: number;
  readonly mediaCount: number;

  readonly coTags: readonly CoTagSummary[];
  readonly properties: readonly PropertySummary[];
}

/** How many co-occurring tags a dashboard shows before it stops being a summary. */
export const MAX_CO_TAGS = 10;

/**
 * Reads a property value as a number, or answers null.
 *
 * Properties are schema-free strings (CLAUDE.md), so "42.50", "€42.50",
 * "42,50 €" and "about forty" are all things someone may genuinely have typed.
 * The first three are worth adding up and the fourth is not.
 *
 * What is handled: a leading or trailing currency symbol or code, surrounding
 * whitespace, and a comma used as the decimal separator — which is what a
 * Spanish or French keyboard produces, and this app's author writes
 * `.barcelona-trip`.
 *
 * What is deliberately *not* handled: thousands separators. "1,234" is 1234 to
 * an English speaker and 1.234 to a Spanish one, and there is nothing in a
 * schema-free string to say which. Guessing would turn a €1.23 coffee into a
 * €1,234 one in someone's expenses, so both readings are refused and the value
 * is simply not counted — visible in `numericCount` rather than silently wrong.
 */
export function parseNumericValue(value: string): number | null {
  const trimmed = value.trim();
  if (trimmed === '') return null;

  // Strip a currency symbol or a three-letter code from either end.
  const withoutCurrency = trimmed
    .replace(/^[\p{Sc}]\s*/u, '')
    .replace(/\s*[\p{Sc}]$/u, '')
    .replace(/\s+[A-Za-z]{3}$/u, '')
    .trim();

  // Ambiguous between a decimal comma and a thousands separator: refuse both.
  if (/[.,]\d{3}(?!\d)/.test(withoutCurrency)) return null;

  const normalised = withoutCurrency.replace(',', '.');

  // Anchored, and no exponent: "1e9" in a free-text field is far more likely to
  // be a model number than a billion.
  if (!/^-?\d+(\.\d+)?$/.test(normalised)) return null;

  const parsed = Number(normalised);
  return Number.isFinite(parsed) ? parsed : null;
}

/** One verse as the summary needs to see it. */
export interface SummaryInput {
  readonly verse: Verse;
  readonly tags: readonly Tag[];
  readonly mediaCount: number;
}

/**
 * Aggregates a tag's verses.
 *
 * `excludeTagId` is the tag being looked at, so it does not appear in its own
 * list of co-occurring tags — where it would be the largest bar by definition
 * and tell the reader nothing.
 */
export function summarise(
  rows: readonly SummaryInput[],
  excludeTagId: string,
): TagSummary {
  const histogram = Array.from({ length: MAX_RATING - MIN_RATING + 1 }, () => 0);

  let firstEvent: Date | null = null;
  let lastEvent: Date | null = null;
  let undatedCount = 0;
  let deepTimeCount = 0;
  let ratedCount = 0;
  let ratingTotal = 0;
  let withMediaCount = 0;
  let mediaCount = 0;

  const coTags = new Map<string, { tag: Tag; count: number }>();
  const properties = new Map<
    string,
    { verseCount: number; numericCount: number; sum: number }
  >();

  for (const { verse, tags, mediaCount: count } of rows) {
    if (verse.deepTimeYears !== null) {
      deepTimeCount += 1;
    } else if (verse.eventStart === null) {
      undatedCount += 1;
    } else {
      if (firstEvent === null || verse.eventStart < firstEvent) {
        firstEvent = verse.eventStart;
      }
      // The *end* of a range extends the span, so a trip booked across a week
      // reaches the end of that week rather than its first day.
      const latest = verse.eventEnd ?? verse.eventStart;
      if (lastEvent === null || latest > lastEvent) lastEvent = latest;
    }

    if (verse.rating !== null) {
      ratedCount += 1;
      ratingTotal += verse.rating;
      const slot = verse.rating - MIN_RATING;
      // `noUncheckedIndexedAccess` is on, so the bound check above does not
      // narrow the read — the explicit `?? 0` is what satisfies it, and costs
      // nothing given the check has already happened.
      if (slot >= 0 && slot < histogram.length)
        histogram[slot] = (histogram[slot] ?? 0) + 1;
    }

    if (count > 0) withMediaCount += 1;
    mediaCount += count;

    for (const tag of tags) {
      if (tag.id === excludeTagId) continue;
      const seen = coTags.get(tag.id);
      if (seen) seen.count += 1;
      else coTags.set(tag.id, { tag, count: 1 });
    }

    for (const [key, value] of Object.entries(verse.properties)) {
      const entry = properties.get(key) ?? { verseCount: 0, numericCount: 0, sum: 0 };
      entry.verseCount += 1;
      const numeric = parseNumericValue(value);
      if (numeric !== null) {
        entry.numericCount += 1;
        entry.sum += numeric;
      }
      properties.set(key, entry);
    }
  }

  return {
    verseCount: rows.length,
    firstEvent,
    lastEvent,
    undatedCount,
    deepTimeCount,
    ratedCount,
    // Rounded to one decimal at the edge rather than left as 7.333333333333333,
    // which is a number no one wants to read and a rounding the UI would only
    // have to do itself.
    averageRating:
      ratedCount === 0 ? null : Math.round((ratingTotal / ratedCount) * 10) / 10,
    ratingHistogram: histogram,
    withMediaCount,
    mediaCount,
    coTags: [...coTags.values()]
      // Count first, then name, so the order is stable across calls rather than
      // depending on which verse happened to be read first.
      .sort((a, b) => b.count - a.count || a.tag.name.localeCompare(b.tag.name))
      .slice(0, MAX_CO_TAGS)
      .map(({ tag, count }) => ({
        id: tag.id,
        name: tag.name,
        // `format` rather than a stored field: how a tag is written — the
        // leading dot — is the domain's business, and duplicating it here
        // would be a second place to keep it right.
        label: format(tag),
        count,
      })),
    properties: [...properties.entries()]
      .sort((a, b) => b[1].verseCount - a[1].verseCount || a[0].localeCompare(b[0]))
      .map(([key, entry]) => ({
        key,
        verseCount: entry.verseCount,
        numericCount: entry.numericCount,
        sum: entry.numericCount === 0 ? null : entry.sum,
      })),
  };
}
