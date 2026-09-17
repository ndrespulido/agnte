'use client';

import { useEffect, useState } from 'react';
import {
  createReminder,
  fetchQuietHours,
  fetchReminders,
  saveQuietHours,
  type QuietHoursView,
  type ReminderView,
} from './api';
import { fromLocalDateTimeInput, localMomentLabel, toLocalDateTimeInput } from './format';
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

/** What the picker offers, as the RRULE each one stands for. */
const REPEATS: { label: string; rule: string | null }[] = [
  { label: 'Once', rule: null },
  { label: 'Every day', rule: 'FREQ=DAILY' },
  { label: 'Every weekday', rule: 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR' },
  { label: 'Every week', rule: 'FREQ=WEEKLY' },
  { label: 'Every month', rule: 'FREQ=MONTHLY' },
  { label: 'Every year', rule: 'FREQ=YEARLY' },
];

const labelForRule = (rule: string | null): string =>
  REPEATS.find((r) => r.rule === rule)?.label ?? rule ?? 'Once';

/** Minutes from midnight as "22:00", for a time input. */
const toTimeInput = (minutes: number): string =>
  `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;

const fromTimeInput = (value: string): number | null => {
  const match = /^(\d{2}):(\d{2})$/.exec(value);
  if (!match) return null;
  return Number(match[1]) * 60 + Number(match[2]);
};

export function Reminders({ onClose }: { onClose: () => void }) {
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
        setError(cause instanceof Error ? cause.message : 'Could not load reminders.');
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
        aria-label="Reminders"
        onClick={(event) => event.stopPropagation()}
      >
        <h2 className="dashboard-title">Reminders</h2>

        <PushToggle
          state={push}
          busy={pushBusy}
          onChange={(next) => {
            setPushBusy(true);
            (next === 'on' ? enablePush() : disablePush())
              .then(setPush)
              .catch((cause: unknown) => {
                setError(
                  cause instanceof Error
                    ? cause.message
                    : 'Could not change notifications.',
                );
              })
              .finally(() => setPushBusy(false));
          }}
        />

        {error ? (
          <p className="notice error" role="alert">
            {error}
          </p>
        ) : null}

        {adding ? (
          <AddReminder
            onCancel={() => setAdding(false)}
            onAdded={() => {
              setAdding(false);
              load();
            }}
          />
        ) : (
          <>
            <button type="button" className="quiet" onClick={() => setAdding(true)}>
              New reminder
            </button>

            <ReminderList reminders={reminders} error={error} />
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
}: {
  reminders: ReminderView[] | null;
  error: string | null;
}) {
  if (reminders === null) return error ? null : <p className="notice">Loading…</p>;

  if (reminders.length === 0) {
    return (
      <p className="notice">
        Nothing scheduled. A reminder can stand on its own — it does not have to be
        attached to a verse.
      </p>
    );
  }

  return (
    <ul className="reminder-rows">
      {reminders.map((reminder) => (
        <li key={reminder.id}>
          <span className="reminder-title">{reminder.title}</span>
          <span className="quiet-note">
            {/* Local, not UTC — see format.ts for why reminders break with the
                rest of the display layer on this. */}
            {localMomentLabel(reminder.fireAt)} · {labelForRule(reminder.recurrence)}
            {reminder.status !== 'pending' ? (
              // `failed` keeps the reason the dispatcher gave up, which is the
              // only place someone can find out a reminder stopped working.
              <> · {reminder.status}</>
            ) : null}
          </span>
        </li>
      ))}
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

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);

    try {
      const when = fromLocalDateTimeInput(fireAt);
      if (!when) throw new Error('Pick a date and time.');
      await createReminder({ title, fireAt: when, recurrence: rule });
      onAdded();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not save that.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="reminder-form" onSubmit={submit}>
      <label className="field">
        Reminder
        <input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="Take the tablet"
          required
          autoFocus
        />
      </label>

      <label className="field">
        When
        <input
          type="datetime-local"
          value={fireAt}
          onChange={(e) => setFireAt(e.target.value)}
          required
        />
      </label>

      <label className="field">
        Repeats
        <select
          value={rule ?? ''}
          onChange={(e) => setRule(e.target.value === '' ? null : e.target.value)}
        >
          {REPEATS.map((option) => (
            <option key={option.label} value={option.rule ?? ''}>
              {option.label}
            </option>
          ))}
        </select>
      </label>

      {error ? (
        <p className="notice error" role="alert">
          {error}
        </p>
      ) : null}

      <div className="sheet-actions">
        <button type="submit" disabled={busy}>
          {busy ? 'Saving…' : 'Schedule'}
        </button>
        <button type="button" className="quiet" onClick={onCancel}>
          Cancel
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
  const [start, setStart] = useState(() => toTimeInput(quiet?.startMinute ?? 22 * 60));
  const [end, setEnd] = useState(() => toTimeInput(quiet?.endMinute ?? 7 * 60));
  const [error, setError] = useState<string | null>(null);
  const enabled = quiet !== null;

  async function save(next: QuietHoursView | null) {
    setError(null);
    try {
      onSaved(await saveQuietHours(next));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not save that.');
    }
  }

  return (
    <section className="dashboard-section">
      <h3>Quiet hours</h3>

      {enabled ? (
        <>
          <div className="quiet-range">
            <label className="field">
              From
              <input
                type="time"
                value={start}
                onChange={(e) => setStart(e.target.value)}
              />
            </label>
            <label className="field">
              To
              <input type="time" value={end} onChange={(e) => setEnd(e.target.value)} />
            </label>
          </div>

          <p className="quiet-note">
            {Intl.DateTimeFormat().resolvedOptions().timeZone}. A reminder that falls
            inside this window waits until it ends rather than being dropped.
          </p>

          <div className="sheet-actions">
            <button
              type="button"
              onClick={() => {
                const from = fromTimeInput(start);
                const to = fromTimeInput(end);
                if (from === null || to === null) return setError('Pick two times.');
                void save({
                  startMinute: from,
                  endMinute: to,
                  timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
                });
              }}
            >
              Save
            </button>
            <button type="button" className="quiet" onClick={() => void save(null)}>
              Turn off
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
          Set quiet hours
        </button>
      )}

      {error ? (
        <p className="notice error" role="alert">
          {error}
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
  if (state === null) return null;

  if (state === 'unsupported') {
    return (
      <p className="data-note">
        This browser cannot show notifications here, so reminders arrive by email. On an
        iPhone, add Agnte to your home screen first.
      </p>
    );
  }

  if (state === 'denied') {
    return (
      <p className="data-note">
        Notifications are blocked for this site, so reminders arrive by email. Your
        browser&rsquo;s site settings are the only place that can undo it.
      </p>
    );
  }

  return (
    <p className="data-note push-toggle">
      <span>
        {state === 'on'
          ? 'Reminders show as notifications on this device.'
          : 'Reminders arrive by email. Notifications are quicker.'}
      </span>
      <button
        type="button"
        className="quiet"
        disabled={busy}
        onClick={() => onChange(state === 'on' ? 'off' : 'on')}
      >
        {busy ? 'Just a moment…' : state === 'on' ? 'Turn off' : 'Turn on'}
      </button>
    </p>
  );
}
