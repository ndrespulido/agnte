'use client';

import { useEffect, useRef, useState } from 'react';
import { createTag, createVerse, fetchTags, uploadImage, type TagView } from './api';
import { downscaleImage } from './downscale';

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

/**
 * One picked image, from the moment it is chosen to the moment the server
 * has it.
 *
 * `previewUrl` is an object URL for the *downscaled* blob, not the original
 * file: it is already in memory, it is the thing actually being uploaded, and
 * previewing it means what the sheet shows is what gets stored.
 */
interface PickedImage {
  key: string;
  previewUrl: string;
  status: 'working' | 'ready' | 'failed';
  mediaId: string | null;
}

function AddSheet({ onClose, onAdded }: { onClose: () => void; onAdded: () => void }) {
  const [tags, setTags] = useState<TagView[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [newTag, setNewTag] = useState('');
  const [xp, setXp] = useState('');
  const [location, setLocation] = useState('');
  const [images, setImages] = useState<PickedImage[]>([]);
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

  /**
   * Object URLs are a manual allocation: the browser holds the blob alive
   * until they are revoked, and a sheet opened and closed a few times with
   * photos in it would keep every one of them.
   *
   * Tracked in a ref, with an unmount-only effect, rather than by depending on
   * `images` — an effect that listed `images` would run its cleanup on every
   * change to the array and revoke URLs that are still on screen, which shows
   * up as previews going blank the moment a second photo is added.
   */
  const objectUrls = useRef(new Set<string>());
  useEffect(
    () => () => {
      for (const url of objectUrls.current) URL.revokeObjectURL(url);
      objectUrls.current.clear();
    },
    [],
  );

  const toggle = (id: string) =>
    setSelected((current) =>
      current.includes(id) ? current.filter((t) => t !== id) : [...current, id],
    );

  /**
   * Downscales and uploads each picked file, one entry at a time so a slow or
   * failing upload shows up against its own thumbnail rather than as one
   * opaque "something went wrong".
   *
   * Deliberately not awaited by the caller: the input's onChange returns
   * immediately and the sheet stays usable — a person can be writing the note
   * while the photo goes up, which is most of the point of doing this here
   * rather than at save time.
   */
  async function addFiles(files: readonly File[]): Promise<void> {
    for (const file of files) {
      const key = crypto.randomUUID();

      try {
        const downscaled = await downscaleImage(file);
        const previewUrl = URL.createObjectURL(downscaled.blob);
        objectUrls.current.add(previewUrl);
        setImages((current) => [
          ...current,
          { key, previewUrl, status: 'working', mediaId: null },
        ]);

        const mediaId = await uploadImage(downscaled);
        setImages((current) =>
          current.map((image) =>
            image.key === key ? { ...image, status: 'ready', mediaId } : image,
          ),
        );
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : 'Could not add that image.');
        setImages((current) =>
          current.map((image) =>
            image.key === key ? { ...image, status: 'failed' } : image,
          ),
        );
      }
    }
  }

  const removeImage = (key: string) =>
    setImages((current) => {
      const going = current.find((image) => image.key === key);
      if (going) {
        URL.revokeObjectURL(going.previewUrl);
        objectUrls.current.delete(going.previewUrl);
      }
      return current.filter((image) => image.key !== key);
    });

  const uploading = images.some((image) => image.status === 'working');

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

      const mediaIds = images
        .filter((image) => image.status === 'ready' && image.mediaId !== null)
        .map((image) => image.mediaId as string);

      await createVerse({
        tagIds,
        xp: xp.trim() === '' ? null : xp.trim(),
        location: location.trim() === '' ? null : location.trim(),
        // The moment it is written is the default placement — the habit this
        // app came from is messaging yourself something *now*.
        eventStart: new Date().toISOString(),
        ...(mediaIds.length > 0 ? { mediaIds } : {}),
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
          <legend>Photos</legend>
          {images.length > 0 ? (
            <ul className="picked-images">
              {images.map((image) => (
                <li key={image.key} data-status={image.status}>
                  {/* eslint-disable-next-line @next/next/no-img-element --
                      next/image wants a known width and height and rewrites
                      the URL through the optimiser; this is a local blob:
                      URL of a picture already sized to fit. */}
                  <img src={image.previewUrl} alt="" />
                  <button
                    type="button"
                    className="remove"
                    aria-label="Remove this photo"
                    onClick={() => removeImage(image.key)}
                  >
                    ×
                  </button>
                  {image.status === 'working' ? (
                    <span className="badge" role="status">
                      Uploading…
                    </span>
                  ) : null}
                  {image.status === 'failed' ? (
                    <span className="badge failed">Failed</span>
                  ) : null}
                </li>
              ))}
            </ul>
          ) : null}

          {/* A label wrapping a hidden input, rather than a button that
              clicks one: the native control cannot be styled to match the
              rest of the sheet, and this keeps it a real file input for the
              keyboard and for assistive tech. */}
          <label className="file-picker">
            <input
              type="file"
              accept="image/*"
              multiple
              onChange={(event) => {
                const files = [...(event.target.files ?? [])];
                // The input is cleared so picking the same file twice in a
                // row still fires a change event.
                event.target.value = '';
                void addFiles(files);
              }}
            />
            <span>{images.length === 0 ? 'Add photos' : 'Add another'}</span>
          </label>
        </fieldset>

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
          {/* Blocked while a photo is still going up, rather than saving
              without it: a verse that quietly loses the picture it was
              written about is worse than a two-second wait. */}
          <button
            type="button"
            className="primary"
            onClick={save}
            disabled={saving || uploading}
          >
            {saving ? 'Saving…' : uploading ? 'Uploading…' : 'Add'}
          </button>
        </div>
      </div>
    </div>
  );
}
