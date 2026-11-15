'use client';

import { parseComposer } from '@agnte/core';
import { useEffect, useMemo, useRef, useState } from 'react';
import { createTag, createVerse, fetchTags, type TagView } from './api';
import {
  contentTypeOf,
  kindOfFile,
  uploadAttachment,
  type AttachmentKind,
} from './attach';
import { dateLine, resolveTags, verseFrom } from './compose';
import { useStrings } from './locale';

/**
 * The composer bar: type a verse the way you would message yourself (§12.3).
 *
 * The text is parsed on every keystroke, on the device, by a deterministic
 * grammar — no model reads it. The card above the bar shows what was
 * understood *before* anything is saved, so a wrong reading is visible while
 * it can still be retyped. The literal text is stored with the verse.
 *
 * Photos, files and voice notes are attached from the bar too — picked,
 * pasted or recorded — and upload while the person is still typing.
 *
 * `onOpenForm` is the way out: anything the grammar cannot say (deep time)
 * still goes through the form.
 */
interface Attachment {
  key: number;
  name: string;
  kind: AttachmentKind;
  status: 'working' | 'ready' | 'failed';
  mediaId: string | null;
  reason: string | null;
}

export function Composer({
  onAdded,
  onOpenForm,
}: {
  onAdded: () => void;
  onOpenForm: () => void;
}) {
  const s = useStrings();
  const [text, setText] = useState('');
  const [tags, setTags] = useState<TagView[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [recording, setRecording] = useState(false);
  const nextKey = useRef(0);
  const picker = useRef<HTMLInputElement | null>(null);
  const recorder = useRef<MediaRecorder | null>(null);

  function attach(files: readonly File[]) {
    for (const file of files) {
      const key = (nextKey.current += 1);
      const kind = kindOfFile(contentTypeOf(file));
      const name =
        kind === 'audio' && file.name.startsWith('voice-note')
          ? s.composerBar.voiceNote
          : file.name || s.composerBar.file;
      setAttachments((current) => [
        ...current,
        { key, name, kind, status: 'working', mediaId: null, reason: null },
      ]);

      const settle = (patch: Partial<Attachment>) =>
        setAttachments((current) =>
          current.map((item) => (item.key === key ? { ...item, ...patch } : item)),
        );
      uploadAttachment(file).then(
        (mediaId) => settle({ status: 'ready', mediaId }),
        // The server's reason, translated: "too large" and "that kind of file
        // cannot be added" are the two a person will actually meet.
        (cause: unknown) =>
          settle({
            status: 'failed',
            reason: cause instanceof Error ? cause.message : s.composerBar.attachFailed,
          }),
      );
    }
  }

  /**
   * Hold to talk would be the chat gesture; a toggle is what works with a
   * mouse, a keyboard and a screen reader alike, so it is a toggle.
   *
   * The recording is whatever container the browser produces (webm in Chrome
   * and Firefox, mp4 in Safari) and is attached like any other file. Nothing
   * transcribes it yet.
   */
  async function toggleRecording() {
    if (recorder.current) {
      recorder.current.stop();
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const chunks: Blob[] = [];
      const started = new MediaRecorder(stream);
      started.ondataavailable = (event) => chunks.push(event.data);
      started.onstop = () => {
        // Release the microphone, or the browser's "recording" light stays on.
        for (const track of stream.getTracks()) track.stop();
        recorder.current = null;
        setRecording(false);

        const type = started.mimeType.split(';')[0] || 'audio/webm';
        const blob = new Blob(chunks, { type });
        if (blob.size > 0) {
          const extension = type === 'audio/mp4' ? 'm4a' : 'weba';
          attach([new File([blob], `voice-note.${extension}`, { type })]);
        }
      };
      recorder.current = started;
      started.start();
      setRecording(true);
      setError(null);
    } catch {
      setError(s.composerBar.noMicrophone);
    }
  }

  // Leaving the page mid-recording must not leave the microphone open.
  useEffect(() => () => recorder.current?.stop(), []);

  useEffect(() => {
    let cancelled = false;
    // Without the list, every typed tag would read as "new" — wrong, but
    // harmless: saving looks names up again and the server refuses a
    // duplicate. So a failure here is not worth interrupting anyone for.
    fetchTags()
      .then((loaded) => {
        if (!cancelled) setTags(loaded);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  const typed = text.trim();
  // `now` is taken per parse: "today" typed at 23:59 and sent at 00:01 should
  // be read at the moment it was last looked at, not when the page opened.
  // An attachment alone is something to send — a photo, a tag, nothing else
  // is a whole verse (CLAUDE.md) — so the card appears for it too.
  const active = typed !== '' || attachments.length > 0;
  const composed = useMemo(
    () => (active ? parseComposer(typed, { strings: s, now: new Date() }) : null),
    [active, typed, s],
  );
  const resolved = useMemo(
    () => (composed === null ? [] : resolveTags(composed.tags, tags)),
    [composed, tags],
  );
  const uploading = attachments.some((item) => item.status === 'working');
  // Not while something is still uploading: the verse would be saved without
  // it, and the upload would finish attached to nothing.
  const canSend = composed !== null && resolved.length > 0 && !saving && !uploading;

  async function send() {
    if (composed === null || resolved.length === 0 || saving || uploading) return;
    setSaving(true);
    setError(null);

    try {
      const made: TagView[] = [];
      const labels = [];
      for (const tag of resolved) {
        const final = tag.existing ?? (await createTag(tag.name));
        if (tag.existing === null) made.push(final);
        labels.push({ id: final.id, name: final.name, label: final.label });
      }
      if (made.length > 0) setTags((current) => [...current, ...made]);

      await createVerse(
        {
          ...verseFrom(composed, typed, new Date()),
          tagIds: labels.map((tag) => tag.id),
          // A failed attachment is left out rather than blocking the verse;
          // its chip says it failed, in the server's words.
          mediaIds: attachments.flatMap((item) =>
            item.mediaId === null ? [] : [item.mediaId],
          ),
        },
        labels,
      );
      setText('');
      setAttachments([]);
      onAdded();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : s.verse.couldNotSave);
    } finally {
      setSaving(false);
    }
  }

  const date = composed === null ? null : dateLine(composed, new Date(), s);
  const properties = composed === null ? [] : Object.entries(composed.properties);

  return (
    <div className="composer">
      {composed !== null ? (
        <div
          className="composer-card"
          aria-live="polite"
          aria-label={s.composerBar.understood}
        >
          {composed.xp !== null ? <p className="composer-note">{composed.xp}</p> : null}

          <dl className="composer-facts">
            {date !== null ? (
              <div>
                <dt>{s.verse.when}</dt>
                <dd>{date}</dd>
              </div>
            ) : null}
            {composed.location !== null ? (
              <div>
                <dt>{s.verse.where}</dt>
                <dd>{composed.location}</dd>
              </div>
            ) : null}
            {composed.rating !== null ? (
              <div>
                <dt>{s.verse.rating}</dt>
                <dd>{composed.rating}/10</dd>
              </div>
            ) : null}
            {composed.visibility !== null ? (
              <div>
                <dt>{s.verse.visibility}</dt>
                <dd>{composed.visibility}</dd>
              </div>
            ) : null}
            {properties.map(([key, value]) => (
              <div key={key}>
                <dt>{key}</dt>
                <dd>{value}</dd>
              </div>
            ))}
          </dl>

          {resolved.length > 0 ? (
            <p className="composer-tags">
              {resolved.map((tag) => (
                <span key={tag.name}>
                  .{tag.name}
                  {tag.existing === null ? <em> {s.composerBar.newTag}</em> : null}
                </span>
              ))}
            </p>
          ) : (
            <p className="composer-hint">{s.composerBar.needsTag}</p>
          )}

          {composed.unread.length > 0 ? (
            <p className="composer-hint">
              {s.composerBar.notUnderstood}{' '}
              {composed.unread.map((item) => `${item.key}: ${item.value}`).join(' · ')}
            </p>
          ) : null}

          {attachments.length > 0 ? (
            <ul className="composer-attachments">
              {attachments.map((item) => (
                <li key={item.key} className={item.status}>
                  <span>
                    {item.status === 'failed' ? (item.reason ?? item.name) : item.name}
                  </span>
                  <button
                    type="button"
                    aria-label={`${s.composerBar.remove} ${item.name}`}
                    onClick={() =>
                      setAttachments((current) =>
                        current.filter((other) => other.key !== item.key),
                      )
                    }
                  >
                    ×
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}

      {/* Outside the card: a refused microphone has no card to appear in. */}
      {error !== null ? (
        <p className="error composer-error" role="alert">
          {error}
        </p>
      ) : null}

      <form
        className="composer-bar"
        onSubmit={(event) => {
          event.preventDefault();
          void send();
        }}
      >
        <button
          type="button"
          className="composer-plus"
          aria-label={s.composerBar.openForm}
          onClick={onOpenForm}
        >
          <span aria-hidden="true">+</span>
        </button>
        <input
          ref={picker}
          type="file"
          multiple
          hidden
          onChange={(event) => {
            attach([...(event.target.files ?? [])]);
            // Reset, or picking the same file twice in a row does nothing.
            event.target.value = '';
          }}
        />
        <button
          type="button"
          className="composer-tool"
          aria-label={s.composerBar.attach}
          onClick={() => picker.current?.click()}
        >
          <span aria-hidden="true">⌁</span>
        </button>
        <button
          type="button"
          className="composer-tool"
          aria-label={recording ? s.composerBar.stopRecording : s.composerBar.record}
          aria-pressed={recording}
          onClick={() => void toggleRecording()}
        >
          <span aria-hidden="true">{recording ? '■' : '●'}</span>
        </button>
        <input
          type="text"
          value={text}
          onChange={(event) => setText(event.target.value)}
          onPaste={(event) => {
            // A pasted screenshot or file is attached; pasted text is left to
            // the browser, which already knows how to paste text.
            const files = [...event.clipboardData.files];
            if (files.length === 0) return;
            event.preventDefault();
            attach(files);
          }}
          placeholder={recording ? s.composerBar.recording : s.composerBar.placeholder}
          aria-label={s.composerBar.placeholder}
          autoComplete="off"
          autoCapitalize="sentences"
          enterKeyHint="send"
        />
        <button type="submit" className="composer-send" disabled={!canSend}>
          {saving ? s.common.saving : s.verse.add}
        </button>
      </form>
    </div>
  );
}
