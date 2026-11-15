import { uploadImage } from './api';
import { downscaleImage } from './downscale';

/**
 * One thing attached in the composer: a photo, a file, or a voice note.
 *
 * Uploaded as soon as it is picked rather than when the verse is sent, so the
 * wait happens while the person is still typing and "Add" is instant. What
 * the verse carries is only the resulting media id.
 */
export type AttachmentKind = 'image' | 'audio' | 'video' | 'file';

export const kindOfFile = (contentType: string): AttachmentKind => {
  if (contentType.startsWith('image/')) return 'image';
  if (contentType.startsWith('audio/')) return 'audio';
  if (contentType.startsWith('video/')) return 'video';
  return 'file';
};

/**
 * The type to declare for a file.
 *
 * A browser leaves `type` empty for extensions it does not know, and on some
 * systems a `.vcf` or `.csv` is one of them. The extension is the only other
 * evidence there is, and only for the few kinds where that happens.
 */
export function contentTypeOf(file: { type: string; name: string }): string {
  if (file.type !== '') return file.type;
  const extension = file.name.split('.').pop()?.toLowerCase() ?? '';
  const known: Record<string, string> = {
    vcf: 'text/vcard',
    ics: 'text/calendar',
    csv: 'text/csv',
    txt: 'text/plain',
    pdf: 'application/pdf',
  };
  return known[extension] ?? '';
}

/**
 * Send one file and answer with its media id.
 *
 * A photo is downscaled first, exactly as the form does it (§8.3). Everything
 * else goes as it is: there is no client-side way to shrink a PDF or a
 * recording, and the server refuses what is too large or not on its list —
 * the refusal is the message the person sees.
 */
export async function uploadAttachment(file: File): Promise<string> {
  const contentType = contentTypeOf(file);

  if (kindOfFile(contentType) === 'image') {
    return uploadImage(await downscaleImage(file));
  }
  return uploadImage({ blob: file, contentType, fileName: file.name });
}
