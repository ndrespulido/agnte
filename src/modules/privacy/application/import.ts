import { DomainError, type Clock, type Result, err, ok } from '@/shared/kernel';
import { importForUser as importVerse, type ImportSummary } from '@/modules/verse';

/**
 * Reads an `agnte.export.v1` document back into this account (§8.5's other half).
 *
 * Privacy coordinates here exactly as it does for erasure: it validates the
 * envelope and hands each module its own section. Verse writes verses and tags;
 * anything another module owns would be that module's to import.
 *
 * Media is not imported, and cannot be by this route. An export carries photos
 * as expiring links rather than bytes, so there is nothing here to store —
 * re-importing an export restores the writing and the structure, not the
 * images. Said in the response rather than left to be discovered from a
 * timeline with empty tiles.
 */
export interface ImportResult extends ImportSummary {
  readonly mediaImported: false;
  readonly note: string;
}

const KNOWN_FORMAT = 'agnte.export.v1';

export async function importForUser(
  ownerId: string,
  document: Record<string, unknown>,
  clock: Clock,
): Promise<Result<ImportResult, DomainError>> {
  const format = document.format;

  /*
   * The format is checked, not sniffed.
   *
   * A document from somewhere else might happen to have `verses` and `tags`
   * arrays, and guessing at it would write half-understood rows into someone's
   * timeline. Refusing by name costs a converter one extra field and makes a
   * future `agnte.export.v2` a version bump rather than an ambiguity.
   */
  if (format !== KNOWN_FORMAT) {
    return err(
      new DomainError(
        'privacy.unknown_import_format',
        `Expected a "${KNOWN_FORMAT}" document. A converter from another source ` +
          'should produce that format rather than relying on this endpoint ' +
          'guessing at the shape.',
      ),
    );
  }

  const imported = await importVerse(ownerId, document, clock);

  if (!imported.ok) return imported;

  return ok({
    ...imported.value,
    mediaImported: false,
    note: 'Photos are not imported: an export links to them rather than carrying them, and those links expire.',
  });
}
