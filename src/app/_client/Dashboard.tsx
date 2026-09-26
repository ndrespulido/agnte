'use client';

import { useEffect, useState } from 'react';
import { failureMessage, useStrings } from './locale';
import { fetchTagDashboard, type DashboardView } from './api';
import { dayLabel } from './format';

/**
 * A tag's dashboard.
 *
 * CLAUDE.md promises every tag is "a filterable sub-timeline with its own
 * dashboard". The sub-timeline has existed since Phase 2; this is the rest of
 * that sentence — the "query it like a database" half of the pitch, which until
 * now had nothing behind it at all.
 *
 * Presented as numbers and hairline bars rather than charts. The design
 * direction is a 1990s paper agenda (CLAUDE.md), and a paper agenda does not
 * have a donut chart in it; a column of figures with a rule under each is both
 * more honest about the precision on offer and much easier to read at 390px.
 */
export function Dashboard({ tagId, onClose }: { tagId: string; onClose: () => void }) {
  const s = useStrings();
  const [data, setData] = useState<DashboardView | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    fetchTagDashboard(tagId)
      .then((fetched) => {
        if (!cancelled) setData(fetched);
      })
      .catch((cause: unknown) => {
        if (!cancelled) {
          setError(cause instanceof Error ? cause.message : '');
        }
      });

    return () => {
      cancelled = true;
    };
  }, [tagId]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="sheet-backdrop" onClick={onClose} role="presentation">
      <div
        className="sheet dashboard"
        role="dialog"
        aria-modal="true"
        aria-label={data ? s.dashboard.forTag(data.tag.label) : s.dashboard.heading}
        onClick={(event) => event.stopPropagation()}
      >
        {error !== null ? (
          <p className="notice error" role="alert">
            {failureMessage(error, s.dashboard.couldNotOpen)}
          </p>
        ) : null}

        {data === null ? (
          error ? null : (
            <p className="notice">{s.common.loading}</p>
          )
        ) : (
          <>
            <h2 className="dashboard-title">{data.tag.label}</h2>

            {data.truncated ? (
              // Said outright rather than left for someone to wonder about. A
              // total computed over part of the data is worse than no total.
              <p className="notice" role="status">
                {s.dashboard.truncated}
              </p>
            ) : null}

            <Figures data={data} />
            <Ratings data={data} />
            <Properties data={data} />
            <CoTags data={data} />
          </>
        )}

        <div className="sheet-actions">
          <button type="button" className="quiet" onClick={onClose}>
            {s.common.close}
          </button>
        </div>
      </div>
    </div>
  );
}

/** The headline counts: how much is here, and over what span. */
function Figures({ data }: { data: DashboardView }) {
  const s = useStrings();
  const { summary } = data;

  const span =
    summary.firstEvent && summary.lastEvent
      ? summary.firstEvent === summary.lastEvent
        ? dayLabel(new Date(summary.firstEvent), s)
        : `${dayLabel(new Date(summary.firstEvent), s)} — ${dayLabel(new Date(summary.lastEvent), s)}`
      : null;

  return (
    <dl className="figures">
      <Figure label={s.dashboard.verses} value={String(summary.verseCount)} />
      {span ? <Figure label={s.dashboard.span} value={span} /> : null}
      {summary.undatedCount > 0 ? (
        <Figure label={s.dashboard.undated} value={String(summary.undatedCount)} />
      ) : null}
      {summary.deepTimeCount > 0 ? (
        <Figure label={s.dashboard.deepTime} value={String(summary.deepTimeCount)} />
      ) : null}
      {summary.mediaCount > 0 ? (
        <Figure
          label={s.dashboard.photos}
          value={s.dashboard.mediaAcross(summary.mediaCount, summary.withMediaCount)}
        />
      ) : null}
    </dl>
  );
}

function Figure({ label, value }: { label: string; value: string }) {
  return (
    <div className="figure">
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

/**
 * The rating distribution, as hairline bars.
 *
 * Hidden entirely when nothing is rated, rather than shown as eleven empty
 * rows — an empty chart reads as a broken one.
 */
function Ratings({ data }: { data: DashboardView }) {
  const s = useStrings();
  const { summary } = data;
  // `averageRating` is null exactly when nothing is rated, so the second half
  // never fires on its own — it is here because the type says it can, and
  // asserting the invariant is better than rendering "average " with a hole
  // in it the way the untyped interpolation used to.
  if (summary.ratedCount === 0 || summary.averageRating === null) return null;

  const peak = Math.max(...summary.ratingHistogram);

  return (
    <section className="dashboard-section">
      <h3>
        {s.dashboard.ratingHeading}{' '}
        <span className="quiet-note">{s.dashboard.average(summary.averageRating)}</span>
      </h3>
      <ul className="bars">
        {summary.ratingHistogram.map((count, rating) => (
          <li key={rating}>
            <span className="bar-label">{rating}</span>
            <span className="bar-track">
              <span
                className="bar-fill"
                // Width is the only thing inline: it is data, not styling, and
                // there is no CSS-variable-free way to express "42% of the peak"
                // in a stylesheet that does not know the peak.
                style={{ width: peak === 0 ? '0%' : `${(count / peak) * 100}%` }}
              />
            </span>
            <span className="bar-count">{count || ''}</span>
          </li>
        ))}
      </ul>
      {summary.ratedCount < summary.verseCount ? (
        <p className="quiet-note">
          {s.dashboard.ratedOf(summary.ratedCount, summary.verseCount)}
        </p>
      ) : null}
    </section>
  );
}

/** What the tag's properties add up to — the reason this screen exists. */
function Properties({ data }: { data: DashboardView }) {
  const s = useStrings();
  const { summary } = data;
  if (summary.properties.length === 0) return null;

  return (
    <section className="dashboard-section">
      <h3>{s.dashboard.properties}</h3>
      <dl className="figures">
        {summary.properties.map((property) => (
          <div className="figure" key={property.key}>
            <dt>{property.key}</dt>
            <dd>
              {property.sum !== null ? (
                <>
                  {/* Trailing zeros dropped: a total of 142.5 should not read
                      as 142.50 when nothing here knows it is money. */}
                  <strong>{property.sum.toLocaleString()}</strong>
                  {property.numericCount < property.verseCount ? (
                    // The honesty the domain's `numericCount` exists for: a sum
                    // over 9 of 12 values is not a sum over 12.
                    <span className="quiet-note">
                      {' '}
                      {s.dashboard.fromOf(property.numericCount, property.verseCount)}
                    </span>
                  ) : (
                    <span className="quiet-note">
                      {' '}
                      {s.dashboard.across(property.verseCount)}
                    </span>
                  )}
                </>
              ) : (
                <span className="quiet-note">{s.dashboard.on(property.verseCount)}</span>
              )}
            </dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

/** Which other tags these verses are also filed under. */
function CoTags({ data }: { data: DashboardView }) {
  const s = useStrings();
  const { summary } = data;
  if (summary.coTags.length === 0) return null;

  return (
    <section className="dashboard-section">
      <h3>{s.dashboard.alsoTagged}</h3>
      <ul className="co-tags">
        {summary.coTags.map((tag) => (
          <li key={tag.id}>
            <span className="tag">{tag.label}</span>
            <span className="quiet-note">{tag.count}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}
