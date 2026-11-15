import {
  headerLabel,
  parseComposer,
  placementOf,
  timeLabel,
  toDateInput,
  toTimeInput,
  type Composed,
  type EventPrecision,
  type Strings,
} from '@agnte/core';
import type { NewVerse, TagView } from './api';

/**
 * From what the parser read to what the API is sent.
 *
 * The parser (`@agnte/core`) knows the grammar and nothing about this person.
 * This is the step that does: which of the typed tag names already exist,
 * which are a shortcut for one that does, and which would have to be made.
 * Kept apart from the component so it can be tested without a browser.
 */

export interface ResolvedTag {
  /** The name the verse will be filed under — a shortcut already expanded. */
  name: string;
  /** Null when the tag does not exist yet and saving would create it. */
  existing: TagView | null;
}

/**
 * A typed name is, in order: a tag with that name, a tag with that shortcut,
 * or a new tag. Name before shortcut, so making a tag called `.m` is never
 * shadowed by another tag's shortcut — the same precedence the form uses.
 */
export function resolveTags(
  names: readonly string[],
  tags: readonly TagView[],
): ResolvedTag[] {
  const resolved: ResolvedTag[] = [];
  for (const name of names) {
    const existing =
      tags.find((tag) => tag.name === name) ??
      tags.find((tag) => tag.shortcut === name) ??
      null;
    const final = existing?.name ?? name;
    if (!resolved.some((tag) => tag.name === final))
      resolved.push({ name: final, existing });
  }
  return resolved;
}

/**
 * The verse to create. `tagIds` is filled in by the caller once any new tags
 * have been made — a verse cannot be sent without them.
 */
export function verseFrom(
  composed: Composed,
  typedText: string,
  now: Date,
): Omit<NewVerse, 'tagIds'> {
  return {
    xp: composed.xp,
    location: composed.location,
    rating: composed.rating,
    // No date typed means now, as a moment — the habit this app came from is
    // messaging yourself something as it happens.
    eventStart: composed.eventStart ?? now.toISOString(),
    eventEnd: composed.eventEnd,
    eventPrecision: composed.eventPrecision ?? 'minute',
    // Unset stays unset. The server then resolves to the most restrictive of
    // the verse's tags; nothing here may choose a visibility on its own.
    visibility: composed.visibility,
    properties: composed.properties,
    typedText,
  };
}

/** The date line of the card: "Tuesday 5 January 2027 — Wednesday 24 February 2027". */
export function dateLine(composed: Composed, now: Date, s: Strings): string | null {
  if (composed.eventStart === null) return null;

  const label = (iso: string, precision: EventPrecision | null): string => {
    const placement = placementOf({
      eventStart: iso,
      eventPrecision: precision,
      deepTimeYears: null,
      createdAt: iso,
    });
    const time = timeLabel(placement);
    const day = headerLabel(placement, now, s);
    return time === null ? day : `${day}, ${time}`;
  };

  const start = label(composed.eventStart, composed.eventPrecision);
  return composed.eventEnd === null
    ? start
    : `${start} — ${label(composed.eventEnd, composed.eventPrecision)}`;
}

/** What the form holds, in the shape the bar's grammar can say. */
export interface DraftFields {
  xp: string;
  /** Names without the dot. */
  tags: readonly string[];
  properties: Readonly<Record<string, string>>;
  start: { iso: string; precision: EventPrecision } | null;
  endIso: string | null;
  location: string;
  rating: number | null;
  /** `''` for "inherit from tags". */
  visibility: string;
}

const collapse = (text: string): string => text.replace(/\s+/g, ' ').trim();
const keyOf = (name: string): string =>
  name.normalize('NFC').trim().toLowerCase().replace(/\s+/g, '-');

/**
 * The form, back into the one line the bar holds — and whether that line says
 * the same thing.
 *
 * Minimising the form hands its contents to the bar so writing can carry on
 * there. The bar is one line of text in a fixed grammar, so some forms cannot
 * be said in it: a place with a colon in it ("Lisbon: Alfama") reads as a
 * field, a detail named after a reserved word reads as that field, and a
 * note's line breaks do not survive. Rather than minimise into text that
 * means something else, the line is parsed again and compared with what was
 * meant; `lossless: false` is the form's cue to say so and stay open.
 *
 * English keys, which every language accepts, so the line reads the same
 * whatever the interface language is.
 */
export function draftToText(
  fields: DraftFields,
  strings: Strings,
  now: Date,
): { text: string; lossless: boolean } {
  const parts: string[] = [];
  const note = collapse(fields.xp);
  if (note !== '') parts.push(note);

  const location = collapse(fields.location);
  if (location !== '') parts.push(`where: ${location}`);
  if (fields.rating !== null) parts.push(`rating: ${fields.rating}`);
  if (fields.visibility !== '') parts.push(`visibility: ${fields.visibility}`);

  const dated = (iso: string, precision: EventPrecision): string => {
    const time = toTimeInput(iso, precision);
    return `${toDateInput(iso, precision)}${time === '' ? '' : ` ${time}`}`;
  };
  if (fields.start) {
    if (fields.endIso === null) {
      parts.push(`when: ${dated(fields.start.iso, fields.start.precision)}`);
    } else {
      parts.push(`from: ${dated(fields.start.iso, fields.start.precision)}`);
      parts.push(`to: ${dated(fields.endIso, fields.start.precision)}`);
    }
  }

  const properties: Record<string, string> = {};
  for (const [name, value] of Object.entries(fields.properties)) {
    const key = keyOf(name);
    const text = collapse(value);
    if (key === '' || text === '') continue;
    properties[key] = text;
    parts.push(`${key}: ${text}`);
  }
  for (const tag of fields.tags) parts.push(`.${tag}`);

  const text = parts.join(' ');
  const read = parseComposer(text, { strings, now });

  const same =
    read.unread.length === 0 &&
    read.xp === (note === '' ? null : note) &&
    read.location === (location === '' ? null : location) &&
    read.rating === fields.rating &&
    read.visibility === (fields.visibility === '' ? null : fields.visibility) &&
    read.eventStart === (fields.start?.iso ?? null) &&
    read.eventEnd === (fields.start ? fields.endIso : null) &&
    read.eventPrecision === (fields.start?.precision ?? null) &&
    JSON.stringify(read.tags) === JSON.stringify([...fields.tags]) &&
    JSON.stringify(Object.entries(read.properties).sort()) ===
      JSON.stringify(Object.entries(properties).sort());

  return { text, lossless: same };
}
