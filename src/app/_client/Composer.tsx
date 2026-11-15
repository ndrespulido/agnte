'use client';

import { parseComposer } from '@agnte/core';
import { useEffect, useMemo, useState } from 'react';
import { createTag, createVerse, fetchTags, type TagView } from './api';
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
 * `onOpenForm` is the way out: anything the grammar cannot say (images, deep
 * time) still goes through the form.
 */
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
  const composed = useMemo(
    () => (typed === '' ? null : parseComposer(typed, { strings: s, now: new Date() })),
    [typed, s],
  );
  const resolved = useMemo(
    () => (composed === null ? [] : resolveTags(composed.tags, tags)),
    [composed, tags],
  );
  const canSend = composed !== null && resolved.length > 0 && !saving;

  async function send() {
    if (composed === null || resolved.length === 0 || saving) return;
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
        },
        labels,
      );
      setText('');
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

          {error !== null ? <p className="error">{error}</p> : null}
        </div>
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
          type="text"
          value={text}
          onChange={(event) => setText(event.target.value)}
          placeholder={s.composerBar.placeholder}
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
