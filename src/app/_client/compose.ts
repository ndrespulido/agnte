import {
  headerLabel,
  placementOf,
  timeLabel,
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
