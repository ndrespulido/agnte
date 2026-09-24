'use client';

import { useEffect, useState } from 'react';
import {
  createReminder,
  createTag,
  createVerse,
  fetchQuietHours,
  fetchReminders,
  fetchTags,
  saveQuietHours,
  type QuietHoursView,
  type ReminderView,
  type TagView,
} from './api';
import {
  REMINDER_TAG,
  planTags,
  reminderVerseFields,
  normaliseTagName,
} from './reminder-verse';
import {
  fromLocalDateTimeInput,
  localMomentLabel,
  splitTagNames,
  toLocalDateTimeInput,
} from './format';
import { failureMessage, useStrings } from './locale';
import type { Strings } from '@/shared/i18n';
import { disablePush, enablePush, pushState, type PushState } from './push';

/**
 * Reminders, and the hours not to send them in.
 *
 * The recurrence field offers four rules rather than a free-text RRULE box.
 * The server accepts a documented subset (FREQ, INTERVAL, BYDAY, UNTIL, COUNT)
 * and refuses the rest, so a text box would mostly be a way to discover that by
 * trial and error — and "every weekday" is a sentence, not a syntax anyone
 * should be asked to type.
 */

/**
 * What the picker offers, as the RRULE each one stands for.
 *
 * The rule is the identity and the label is looked up, rather than the pair
 * being one translated constant: the RRULE goes to the server and must not
 * move when the language does.
 */
const REPEAT_RULES = [
  null,
  'FREQ=DAILY',
  'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR',
  'FREQ=WEEKLY',
  'FREQ=MONTHLY',
  'FREQ=YEARLY',
] as const;

function labelForRule(rule: string | null, s: Strings): string {
  switch (rule) {
    case null:
      return s.reminders.once;
    case 'FREQ=DAILY':
      return s.reminders.everyDay;
    case 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR':
      return s.reminders.everyWeekday;
    case 'FREQ=WEEKLY':
      return s.reminders.everyWeek;
    case 'FREQ=MONTHLY':
      return s.reminders.everyMonth;
    case 'FREQ=YEARLY':
      return s.reminders.everyYear;
    // A rule created through the API that this picker does not offer: shown
    // as itself rather than hidden or mislabelled as "Once".
    default:
      return rule;
  }
}

/** Minutes from midnight as "22:00", for a time input. */
const toTimeInput = (minutes: number): string =>
  `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;

const fromTimeInput = (value: string): number | null => {
  const match = /^(\d{2}):(\d{2})$/.exec(value);
  if (!match) return null;
  return Number(match[1]) * 60 + Number(match[2]);
};

export function Reminders({
  onClose,
  onOpenVerse,
  onScheduled,
}: {
  onClose: () => void;
  /** Opens the verse behind a reminder, over the timeline. */
  onOpenVerse: (verseId: string) => void;
  /** A reminder was scheduled, so the timeline behind has a new verse on it. */
  onScheduled: () => void;
}) {
  const s = useStrings();
  const [reminders, setReminders] = useState<ReminderView[] | null>(null);
  const [quiet, setQuiet] = useState<QuietHoursView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [push, setPush] = useState<PushState | null>(null);
  const [pushBusy, setPushBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    pushState()
      .then((state) => {
        if (!cancelled) setPush(state);
      })
      .catch(() => {
        if (!cancelled) setPush('unsupported');
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const load = () => {
    Promise.all([fetchReminders(), fetchQuietHours()])
      .then(([list, hours]) => {
        setReminders(list);
        setQuiet(hours);
      })
      .catch((cause: unknown) => {
        setError(cause instanceof Error ? cause.message : '');
      });
  };

  useEffect(load, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      // Only when the add form is closed — otherwise one Escape throws away a
      // half-written reminder along with the sheet. Same guard VerseDetail and
      // the tag list document.
      if (event.key === 'Escape' && !adding) onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, adding]);

  return (
    <div className="sheet-backdrop" onClick={onClose} role="presentation">
      <div
        className="sheet reminders"
        role="dialog"
        aria-modal="true"
        aria-label={s.reminders.heading}
        onClick={(event) => event.stopPropagation()}
      >
        <h2 className="dashboard-title">{s.reminders.heading}</h2>

        <PushToggle
          state={push}
          busy={pushBusy}
          onChange={(next) => {
            setPushBusy(true);
            (next === 'on' ? enablePush() : disablePush())
              .then(setPush)
              .catch((cause: unknown) => {
                setError(cause instanceof Error ? cause.message : '');
              })
              .finally(() => setPushBusy(false));
          }}
        />

        {error !== null ? (
          <p className="notice error" role="alert">
            {failureMessage(error, s.reminders.couldNotLoad)}
          </p>
        ) : null}

        {adding ? (
          <AddReminder
            onCancel={() => setAdding(false)}
            onAdded={() => {
              setAdding(false);
              load();
              onScheduled();
            }}
          />
        ) : (
          <>
            <button type="button" className="quiet" onClick={() => setAdding(true)}>
              New reminder
            </button>

            <ReminderList reminders={reminders} error={error} onOpenVerse={onOpenVerse} />
            <QuietHoursField quiet={quiet} onSaved={setQuiet} />
          </>
        )}

        <div className="sheet-actions">
          <button type="button" className="quiet" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}

function ReminderList({
  reminders,
  error,
  onOpenVerse,
}: {
  reminders: ReminderView[] | null;
  error: string | null;
  onOpenVerse: (verseId: string) => void;
}) {
  const s = useStrings();

  if (reminders === null) {
    return error !== null ? null : <p className="notice">{s.common.loading}</p>;
  }

  if (reminders.length === 0) {
    return <p className="notice">{s.reminders.none}</p>;
  }

  return (
    <ul className="reminder-rows">
      {reminders.map((reminder) => {
        const when = (
          <span className="quiet-note">
            {/* Local, not UTC — see format.ts for why reminders break with the
                rest of the display layer on this. */}
            {localMomentLabel(reminder.fireAt, s)} ·{' '}
            {labelForRule(reminder.recurrence, s)}
            {reminder.status !== 'pending' ? (
              // `failed` keeps the reason the dispatcher gave up, which is the
              // only place someone can find out a reminder stopped working.
              <> · {reminder.status}</>
            ) : null}
          </span>
        );

        /*
         * A reminder made here has a verse behind it, so the row opens it.
         *
         * Not every row does: a reminder can still be created through the API
         * with no verse, and one made before this existed has none either. A
         * plain row rather than a dead button for those — an affordance that
         * does nothing is worse than none.
         */
        if (reminder.verseId === null) {
          return (
            <li key={reminder.id}>
              <span className="reminder-title">{reminder.title}</span>
              {when}
            </li>
          );
        }

        return (
          <li key={reminder.id}>
            <button
              type="button"
              className="reminder-open"
              onClick={() => onOpenVerse(reminder.verseId as string)}
            >
              <span className="reminder-title">{reminder.title}</span>
              {when}
            </button>
          </li>
        );
      })}
    </ul>
  );
}

function AddReminder({
  onCancel,
  onAdded,
}: {
  onCancel: () => void;
  onAdded: () => void;
}) {
  const s = useStrings();
  const [title, setTitle] = useState('');
  const [fireAt, setFireAt] = useState(() => {
    // An hour from now, rounded: the server refuses a time in the past, and
    // defaulting to "now" would put every form one keystroke from that error.
    const soon = new Date(Date.now() + 60 * 60 * 1000);
    soon.setMinutes(0, 0, 0);
    return toLocalDateTimeInput(soon.toISOString());
  });
  const [rule, setRule] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /**
   * The tags to put on the verse, beyond `.reminder` itself.
   *
   * Loaded rather than typed-only, because the point of this is that a
   * reminder lands among everything else it belongs with — `.flight` for the
   * check-in nudge, `.barcelona-trip` for the whole thing — and those tags
   * already exist by the time anyone is scheduling against them.
   */
  const [tags, setTags] = useState<TagView[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [newTag, setNewTag] = useState('');

  useEffect(() => {
    let cancelled = false;
    fetchTags()
      .then((list) => {
        if (!cancelled) setTags(list);
      })
      // Silent: tags are an addition here, not the point of the form, and a
      // failure to list them must not stop someone scheduling a reminder.
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);

    try {
      const when = fromLocalDateTimeInput(fireAt);
      if (!when) throw new Error(s.reminders.pickADateAndTime);

      /*
       * `.reminder` first, then whatever was chosen or typed.
       *
       * It is an ordinary tag, not a flag: it has a dashboard, it can be
       * filtered to, and it can be removed from a verse that has outgrown
       * being a reminder. Asked for by name so it is made on first use rather
       * than seeded, which keeps a brand new account's tag list empty until
       * they do something.
       */
      const wanted = [REMINDER_TAG, ...splitTagNames(newTag)];
      const plan = planTags(wanted, tags, selected);

      const tagIds = [...plan.ids];
      const made: TagView[] = [];
      for (const name of plan.create) {
        const tag = await createTag(name);
        made.push(tag);
        tagIds.push(tag.id);
      }
      if (made.length > 0) setTags((current) => [...current, ...made]);

      /*
       * The verse is written first, and through the outbox, so it survives a
       * network that drops between the two writes (§8.1). The reminder then
       * names it.
       *
       * The reverse order would be worse in the same situation: a reminder
       * pointing at a verse that was never queued fires a notification which
       * opens nothing. This way the failure leaves a verse on the timeline
       * with no reminder behind it — visible, editable, and obviously
       * incomplete rather than silently broken.
       */
      const known = [...tags, ...made];
      const verseId = await createVerse(
        reminderVerseFields({ title, fireAt: when, tagIds }),
        // The labels the timeline draws the row with before the server has
        // ever seen it (api.ts). Every id here came from `known`, so the
        // fallback is unreachable — it exists so a future caller adding an id
        // from somewhere else gets a readable chip rather than a crash.
        tagIds.map((id) => {
          const tag = known.find((candidate) => candidate.id === id);
          const name = tag?.name ?? normaliseTagName(REMINDER_TAG);
          return { id, name, label: `.${name}` };
        }),
      );

      await createReminder({ title, fireAt: when, recurrence: rule, verseId });

      setNewTag('');
      onAdded();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '');
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="reminder-form" onSubmit={submit}>
      <label className="field">
        {s.reminders.reminderLabel}
        <input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder={s.reminders.titlePlaceholder}
          required
          autoFocus
        />
      </label>

      <label className="field">
        {s.reminders.when}
        <input
          type="datetime-local"
          value={fireAt}
          onChange={(e) => setFireAt(e.target.value)}
          required
        />
      </label>

      <label className="field">
        {s.reminders.repeats}
        <select
          value={rule ?? ''}
          onChange={(e) => setRule(e.target.value === '' ? null : e.target.value)}
        >
          {REPEAT_RULES.map((option) => (
            <option key={option ?? 'once'} value={option ?? ''}>
              {labelForRule(option, s)}
            </option>
          ))}
        </select>
      </label>

      <fieldset className="field">
        <legend>{s.reminders.tags}</legend>
        <p className="quiet-note">{s.reminders.landsAsAVerse}</p>
        <div className="tag-picker">
          {/*
            `.reminder` is not offered as a chip, because it is not optional —
            every reminder verse gets it. A chip that stays on however it is
            pressed is a control that lies about what it does, and the sentence
            above already says the tag is there.
          */}
          {tags
            .filter((tag) => tag.name !== REMINDER_TAG)
            .map((tag) => (
              <button
                key={tag.id}
                type="button"
                className={selected.includes(tag.id) ? 'tag chosen' : 'tag'}
                aria-pressed={selected.includes(tag.id)}
                onClick={() =>
                  setSelected((current) =>
                    current.includes(tag.id)
                      ? current.filter((id) => id !== tag.id)
                      : [...current, tag.id],
                  )
                }
              >
                {tag.label}
              </button>
            ))}
        </div>
        <input
          value={newTag}
          onChange={(e) => setNewTag(e.target.value)}
          placeholder={s.reminders.newTagsPlaceholder}
        />
      </fieldset>

      {error !== null ? (
        <p className="notice error" role="alert">
          {failureMessage(error, s.reminders.couldNotSave)}
        </p>
      ) : null}

      <div className="sheet-actions">
        <button type="submit" disabled={busy}>
          {busy ? s.common.saving : s.reminders.schedule}
        </button>
        <button type="button" className="quiet" onClick={onCancel}>
          {s.common.cancel}
        </button>
      </div>
    </form>
  );
}

/**
 * The window not to send in.
 *
 * The time zone is taken from the browser rather than asked for. It is the one
 * piece of this the person cannot get wrong and the machine cannot get wrong
 * either, and asking would be a dropdown of four hundred entries to answer a
 * question the device already knows.
 */
function QuietHoursField({
  quiet,
  onSaved,
}: {
  quiet: QuietHoursView | null;
  onSaved: (quiet: QuietHoursView | null) => void;
}) {
  const s = useStrings();
  const [start, setStart] = useState(() => toTimeInput(quiet?.startMinute ?? 22 * 60));
  const [end, setEnd] = useState(() => toTimeInput(quiet?.endMinute ?? 7 * 60));
  const [error, setError] = useState<string | null>(null);
  const enabled = quiet !== null;

  async function save(next: QuietHoursView | null) {
    setError(null);
    try {
      onSaved(await saveQuietHours(next));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '');
    }
  }

  return (
    <section className="dashboard-section">
      <h3>{s.reminders.quietHours}</h3>

      {enabled ? (
        <>
          <div className="quiet-range">
            <label className="field">
              {s.reminders.from}
              <input
                type="time"
                value={start}
                onChange={(e) => setStart(e.target.value)}
              />
            </label>
            <label className="field">
              {s.reminders.to}
              <input type="time" value={end} onChange={(e) => setEnd(e.target.value)} />
            </label>
          </div>

          <p className="quiet-note">
            {s.reminders.quietWindowNote(
              Intl.DateTimeFormat().resolvedOptions().timeZone,
            )}
          </p>

          <div className="sheet-actions">
            <button
              type="button"
              onClick={() => {
                const from = fromTimeInput(start);
                const to = fromTimeInput(end);
                if (from === null || to === null) {
                  return setError(s.reminders.pickTwoTimes);
                }
                void save({
                  startMinute: from,
                  endMinute: to,
                  timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
                });
              }}
            >
              {s.common.save}
            </button>
            <button type="button" className="quiet" onClick={() => void save(null)}>
              {s.reminders.turnOff}
            </button>
          </div>
        </>
      ) : (
        <button
          type="button"
          className="quiet"
          onClick={() =>
            void save({
              startMinute: 22 * 60,
              endMinute: 7 * 60,
              timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
            })
          }
        >
          {s.reminders.setQuietHours}
        </button>
      )}

      {error !== null ? (
        <p className="notice error" role="alert">
          {failureMessage(error, s.reminders.couldNotSave)}
        </p>
      ) : null}
    </section>
  );
}

/**
 * Notifications on this browser.
 *
 * Deliberately a row inside Reminders rather than a prompt on load: the
 * permission dialogue is the one a person dismisses when it arrives unasked,
 * and on most browsers a dismissal is a denial that cannot be asked about
 * again. Here it sits where someone is already thinking about being reminded.
 *
 * Every state says what is actually true, including the two the app cannot fix
 * — a browser that does not do push, and a permission already refused — because
 * "reminders are on" next to a browser that will never show one is exactly the
 * silent failure this feature is for.
 */
function PushToggle({
  state,
  busy,
  onChange,
}: {
  state: PushState | null;
  busy: boolean;
  onChange: (next: 'on' | 'off') => void;
}) {
  const s = useStrings();

  if (state === null) return null;

  if (state === 'unsupported') {
    return <p className="data-note">{s.reminders.notificationsUnsupported}</p>;
  }

  if (state === 'denied') {
    return <p className="data-note">{s.reminders.notificationsBlocked}</p>;
  }

  return (
    <p className="data-note push-toggle">
      <span>{state === 'on' ? s.reminders.onThisDevice : s.reminders.byEmail}</span>
      <button
        type="button"
        className="quiet"
        disabled={busy}
        onClick={() => onChange(state === 'on' ? 'off' : 'on')}
      >
        {busy
          ? s.reminders.justAMoment
          : state === 'on'
            ? s.reminders.turnOff
            : s.reminders.turnOn}
      </button>
    </p>
  );
}
