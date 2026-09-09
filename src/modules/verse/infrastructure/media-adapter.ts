import { ownedMediaIds, resolveMediaForVerse } from '@/modules/media';
import type { MediaOwnership, MediaResolver, VerseMedia } from '../domain/ports';

/**
 * The one place verse imports `@/modules/media` (the module boundary rule
 * allows reaching another module's index.ts from anywhere, but keeping it to
 * a single file makes it the one thing to check if that integration ever
 * needs to change). Maps media's own return shape onto verse's `VerseMedia`
 * field by field, rather than re-exporting it, so the two stay decoupled
 * even though they agree today (domain/ports.ts's `VerseMedia` doc comment).
 */
export class MediaModuleAdapter implements MediaOwnership, MediaResolver {
  ownedMediaIds(
    ownerId: string,
    mediaIds: readonly string[],
  ): Promise<ReadonlySet<string>> {
    return ownedMediaIds(ownerId, mediaIds);
  }

  async resolveForVerse(
    ownerId: string,
    mediaIds: readonly string[],
  ): Promise<VerseMedia[]> {
    const found = await resolveMediaForVerse(ownerId, mediaIds);
    return found.map((media) => ({
      id: media.id,
      status: media.status,
      originalUrl: media.originalUrl,
      thumbUrl: media.thumbUrl,
      mediumUrl: media.mediumUrl,
    }));
  }
}
