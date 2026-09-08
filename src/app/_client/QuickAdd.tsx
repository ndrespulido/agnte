'use client';

import { useEffect, useRef, useState } from 'react';
import { createTag, createVerse, fetchTags, type TagView } from './api';

/**
 * The add button and its sheet.
 *
 * The button is the "metallic paper" from CLAUDE.md: a soft vertical
 * silver-to-pewter gradient with a 1px lighter top edge and darker bottom edge,
 * and a very soft shadow. No gloss, no bevel — the styling is in globals.css so
 * the gradient and its two edges sit together where they can be read as one
 * idea.
 *
 * The sheet asks for as little as possible, because a Verse may be minimal: one
 * tag is the only requirement, and everything else is optional by design rather
 * than by omission.
 */
export function QuickAdd({ onAdded }: { onAdded: () => void }) {
  const [open, setOpen] = useState(false);

  return (
    <>
      <button
        type="button"
        className="add-button"
        aria-label="Add a verse"
        aria-expanded={open}
        onClick={() => setOpen(true)}
      >
        <span aria-hidden="true">+</span>
      </button>

      {open ? (
        <AddSheet
          onClose={() => setOpen(false)}
          onAdded={() => {
            setOpen(false);
            onAdded();
          }}
        />
      ) : null}
    </>
  );
}

function AddSheet({ onClose, onAdded }: { onClose: () => void; onAdded: () => void }) {
  const [tags, setTags] = useState<TagView[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [newTag, setNewTag] = useState('');
  const [xp, setXp] = useState('');
  const [location, setLocation] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const firstFieldRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    void fetchTags()
      .then(setTags)
      .catch(() => setError('Could not load your tags.'));
    firstFieldRef.current?.focus();
  }, []);

  // Escape closes. A sheet that can only be dismissed by a small × is a sheet
  // people close by reloading the page.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const toggle = (id: string) =>
    setSelected((current) =>
      current.includes(id) ? current.filter((t) => t !== id) : [...current, id],
    );

  async function save() {
    setSaving(true);
    setError(null);

    try {
      let tagIds = [...selected];

      const wanted = newTag.trim();
      if (wanted.length > 0) {
        const created = await createTag(wanted);
        tagIds = [...tagIds, created.id];
        setTags((current) => [...current, created]);
        setNewTag('');
      }

      if (tagIds.length === 0) {
        setError('A verse needs at least one tag.');
        return;
      }

      await createVerse({
        tagIds,
        xp: xp.trim() === '' ? null : xp.trim(),
        location: location.trim() === '' ? null : location.trim(),
        // The moment it is written is the default placement — the habit this
        // app came from is messaging yourself something *now*.
        eventStart: new Date().toISOString(),
      });

      onAdded();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not save.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="sheet-backdrop" onClick={onClose} role="presentation">
      <div
        className="sheet"
        role="dialog"
        aria-modal="true"
        aria-label="Add a verse"
        onClick={(event) => event.stopPropagation()}
      >
        <label className="field">
          <span>What happened</span>
          <textarea
            ref={firstFieldRef}
            value={xp}
            onChange={(event) => setXp(event.target.value)}
            rows={3}
            placeholder="Optional — a verse can be just a tag."
          />
        </label>

        <label className="field">
          <span>Where</span>
          <input
            value={location}
            onChange={(event) => setLocation(event.target.value)}
            placeholder="Optional"
          />
        </label>

        <fieldset className="field">
          <legend>Tags</legend>
          <div className="tag-picker">
            {tags.map((tag) => (
              <button
                key={tag.id}
                type="button"
                className={selected.includes(tag.id) ? 'tag chosen' : 'tag'}
                aria-pressed={selected.includes(tag.id)}
                onClick={() => toggle(tag.id)}
              >
                {tag.label}
              </button>
            ))}
          </div>
          <input
            value={newTag}
            onChange={(event) => setNewTag(event.target.value)}
            placeholder="or a new one, like .barcelona-trip"
            aria-label="New tag"
          />
        </fieldset>

        {error ? (
          <p className="notice error" role="alert">
            {error}
          </p>
        ) : null}

        <div className="sheet-actions">
          <button type="button" className="quiet" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="primary" onClick={save} disabled={saving}>
            {saving ? 'Saving…' : 'Add'}
          </button>
        </div>
      </div>
    </div>
  );
}
