import { describe, expect, it } from 'vitest';
import { contentTypeOf, kindOfFile } from '@/app/_client/attach';

describe('contentTypeOf', () => {
  it('believes the browser when it has an answer', () => {
    expect(contentTypeOf({ type: 'application/pdf', name: 'x.txt' })).toBe(
      'application/pdf',
    );
  });

  it('falls back to the extension for the kinds a browser leaves blank', () => {
    expect(contentTypeOf({ type: '', name: 'Marta.VCF' })).toBe('text/vcard');
    expect(contentTypeOf({ type: '', name: 'invite.ics' })).toBe('text/calendar');
  });

  it('does not guess past that, so the server refuses rather than mislabels', () => {
    expect(contentTypeOf({ type: '', name: 'installer.exe' })).toBe('');
    expect(contentTypeOf({ type: '', name: 'no-extension' })).toBe('');
  });
});

describe('kindOfFile', () => {
  it.each([
    ['image/jpeg', 'image'],
    ['audio/webm', 'audio'],
    ['video/mp4', 'video'],
    ['application/pdf', 'file'],
    ['', 'file'],
  ])('%j is %s', (type, kind) => {
    expect(kindOfFile(type)).toBe(kind);
  });
});
