'use client';

import { useEffect, useRef, useState } from 'react';
import {
  createTag,
  createVerse,
  fetchTags,
  updateVerse,
  uploadImage,
  VersionConflict,
  type TagView,
  type VerseView,
} from './api';
import { downscaleImage } from './downscale';
import { fromDateTimeInput, toDateTimeInput } from './format';

/**
 * The sheet that writes a Verse — one component for both creating and
 * editing.
 *
 * They were briefly two. Every field the editor needs is a field the adder
 * should offer (a date you can only set *after* saving is a strange thing to
 * ship), and every rule about them — a tag is required, a photo still
 * uploading blocks the save — is identical. Two copies of that is two places
 * for it to drift. What actually differs is three lines: which request goes
 * out, whether there is a version to send with it, and what the button says.
 *
 * `initial` present means edit. Its `version` is carried through the save so
 * a stale write is refused (409) rather than quietly overwriting whatever
 * changed underneath.
 */
export function VerseSheet({
  initial,
  onClose,
  onSaved,
}: {
  initial?: VerseView;
  onClose: () => void;
  onSaved: () => void;
}) {
  const editing = initial !== undefined;

  const [tags, setTags] = useState<TagView[]>([]);
  const [selected, setSelected] = useState<string[]>(
    initial ? initial.tags.map((t) => t.id) : [],
  );
  const [newTag, setNewTag] = useState('');
  const [xp, setXp] = useState(initial?.xp ?? '');
  const [location, setLocation] = useState(initial?.location ?? '');
  const [rating, setRating] = useState(
    initial?.rating === null || initial?.rating === undefined
      ? ''
      : String(initial.rating),
  );
  const [visibility, setVisibility] = useState(initial?.explicitVisibility ?? '');
  const [eventStart, setEventStart] = useState(
    toDateTimeInput(initial?.eventStart ?? null),
  );
  const [eventEnd, setEventEnd] = useState(toDateTimeInput(initial?.eventEnd ?? null));
  const [properties, setProperties] = useState<PropertyRow[]>(
    initial ? asRows(initial.properties) : [],
  );
  const [images, setImages] = useState<PickedImage[]>(
    initial ? initial.media.map(asPicked) : [],
  );

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
   *
   * Only blobs this sheet made go in here. An already-saved photo's preview is
   * a signed URL from the server, which is not ours to revoke.
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
      // Only revoke what this sheet allocated: a server URL is not a blob.
      if (going && objectUrls.current.has(going.previewUrl)) {
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
        /**
         * Typing the name of a tag that already exists selects it, rather
         * than failing the save.
         *
         * Creating it unconditionally answers "You already have a tag
         * .restaurant" and throws away everything else typed into the sheet —
         * for a field whose whole purpose is "the tag I want isn't in the list
         * above", on an app whose tags are things like `.restaurant` that get
         * reached for constantly. Normalised the same way the domain does
         * (`parseTagName`: leading dots stripped, lowercased) so `.Restaurant`
         * and `restaurant` find it too.
         */
        const normalised = wanted.replace(/^\.+/, '').toLowerCase();
        const existing = tags.find((tag) => tag.name === normalised);

        if (existing) {
          if (!tagIds.includes(existing.id)) tagIds = [...tagIds, existing.id];
          setNewTag('');
        } else {
          const created = await createTag(wanted);
          tagIds = [...tagIds, created.id];
          setTags((current) => [...current, created]);
          setNewTag('');
        }
      }

      if (tagIds.length === 0) {
        setError('A verse needs at least one tag.');
        return;
      }

      const parsedRating = rating.trim() === '' ? null : Number(rating);
      if (parsedRating !== null && (Number.isNaN(parsedRating) || parsedRating < 0)) {
        setError('A rating is a number from 0 to 10.');
        return;
      }

      const mediaIds = images
        .filter((image) => image.status === 'ready' && image.mediaId !== null)
        .map((image) => image.mediaId as string);

      const fields = {
        tagIds,
        xp: blankToNull(xp),
        location: blankToNull(location),
        rating: parsedRating,
        // Empty means "no date" — sent as an explicit null so clearing a date
        // that was there actually clears it rather than being read as "leave".
        eventStart: fromDateTimeInput(eventStart),
        eventEnd: fromDateTimeInput(eventEnd),
        visibility: visibility === '' ? null : visibility,
        properties: asRecord(properties),
        mediaIds,
      };

      if (initial) {
        await updateVerse(initial.id, { ...fields, expectedVersion: initial.version });
      } else {
        await createVerse({
          ...fields,
          // The moment it is written is the default placement — the habit this
          // app came from is messaging yourself something *now* — but only
          // when nothing was typed into the date field.
          eventStart: fields.eventStart ?? new Date().toISOString(),
        });
      }

      onSaved();
    } catch (cause) {
      setError(
        cause instanceof VersionConflict || cause instanceof Error
          ? cause.message
          : 'Could not save.',
      );
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
        aria-label={editing ? 'Edit this verse' : 'Add a verse'}
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
          <legend>When</legend>
          <div className="field-pair">
            <label>
              <span>Starts</span>
              <input
                type="datetime-local"
                value={eventStart}
                onChange={(event) => setEventStart(event.target.value)}
              />
            </label>
            <label>
              {/* A range, not a second event: leaving it empty is the common
                  case, because most things happen at a moment. */}
              <span>Ends</span>
              <input
                type="datetime-local"
                value={eventEnd}
                onChange={(event) => setEventEnd(event.target.value)}
              />
            </label>
          </div>
        </fieldset>

        <div className="field-pair">
          <label className="field">
            <span>Rating</span>
            <input
              type="number"
              min={0}
              max={10}
              value={rating}
              onChange={(event) => setRating(event.target.value)}
              placeholder="0–10"
            />
          </label>

          <label className="field">
            <span>Visibility</span>
            <select
              value={visibility}
              onChange={(event) => setVisibility(event.target.value)}
            >
              {/* Empty is not "private", it is "inherit" — the verse takes the
                  most restrictive of its tags. They look identical until a tag
                  changes, which is exactly when the difference matters. */}
              <option value="">Inherit from tags</option>
              <option value="private">Private</option>
              <option value="shared">Shared</option>
              <option value="public">Public</option>
            </select>
          </label>
        </div>

        <fieldset className="field">
          <legend>Photos</legend>
          {images.length > 0 ? (
            <ul className="picked-images">
              {images.map((image) => (
                <li key={image.key} data-status={image.status}>
                  {/* eslint-disable-next-line @next/next/no-img-element --
                      next/image wants a known width and height and rewrites
                      the URL through the optimiser; these are a local blob:
                      URL and a short-lived signed one, neither of which
                      survives that. */}
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

        <Properties rows={properties} onChange={setProperties} />

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
            {saving ? 'Saving…' : uploading ? 'Uploading…' : editing ? 'Save' : 'Add'}
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * One picked image, from the moment it is chosen to the moment the server
 * has it — or, when editing, one the server already had.
 *
 * `previewUrl` is an object URL for the *downscaled* blob, not the original
 * file: it is already in memory, it is the thing actually being uploaded, and
 * previewing it means what the sheet shows is what gets stored. For an
 * already-saved photo it is the server's signed thumbnail URL instead, which
 * is why `removeImage` checks before revoking.
 */
interface PickedImage {
  key: string;
  previewUrl: string;
  status: 'working' | 'ready' | 'failed';
  mediaId: string | null;
}

/**
 * An already-saved photo as a row of the same list.
 *
 * A `processing` one has no thumbnail yet, so it gets an empty preview and
 * still counts as `ready` — "ready" here means "has an id to send back", not
 * "has been thumbnailed". Dropping it would silently detach the photo from
 * the verse on the next save, which is the opposite of what editing an
 * unrelated field should do.
 */
const asPicked = (media: VerseView['media'][number]): PickedImage => ({
  key: media.id,
  previewUrl: media.thumbUrl ?? '',
  status: media.status === 'failed' ? 'failed' : 'ready',
  mediaId: media.id,
});

interface PropertyRow {
  key: string;
  name: string;
  value: string;
}

const asRows = (properties: Record<string, string>): PropertyRow[] =>
  Object.entries(properties).map(([name, value]) => ({
    key: crypto.randomUUID(),
    name,
    value,
  }));

/** Blank names are dropped rather than written as an empty key. */
const asRecord = (rows: readonly PropertyRow[]): Record<string, string> => {
  const record: Record<string, string> = {};
  for (const row of rows) {
    const name = row.name.trim();
    if (name !== '') record[name] = row.value;
  }
  return record;
};

const blankToNull = (value: string): string | null =>
  value.trim() === '' ? null : value.trim();

/**
 * The free-form half of a Verse (CLAUDE.md: schema-free key/value).
 *
 * Rows carry their own key rather than being indexed by position: typing in
 * the second row after deleting the first would otherwise remount both inputs
 * and lose focus mid-word.
 */
function Properties({
  rows,
  onChange,
}: {
  rows: PropertyRow[];
  onChange: (rows: PropertyRow[]) => void;
}) {
  const set = (key: string, patch: Partial<PropertyRow>) =>
    onChange(rows.map((row) => (row.key === key ? { ...row, ...patch } : row)));

  return (
    <fieldset className="field">
      <legend>Details</legend>

      {rows.map((row) => (
        <div className="field-pair property-row" key={row.key}>
          <input
            value={row.name}
            onChange={(event) => set(row.key, { name: event.target.value })}
            placeholder="e.g. seat"
            aria-label="Detail name"
          />
          <input
            value={row.value}
            onChange={(event) => set(row.key, { value: event.target.value })}
            placeholder="e.g. 14A"
            aria-label="Detail value"
          />
          <button
            type="button"
            className="quiet"
            aria-label={`Remove ${row.name || 'this detail'}`}
            onClick={() => onChange(rows.filter((other) => other.key !== row.key))}
          >
            ×
          </button>
        </div>
      ))}

      <button
        type="button"
        className="quiet add-property"
        onClick={() =>
          onChange([...rows, { key: crypto.randomUUID(), name: '', value: '' }])
        }
      >
        Add a detail
      </button>
    </fieldset>
  );
}
