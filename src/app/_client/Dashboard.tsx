'use client';

import { useEffect, useState } from 'react';
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
          setError(
            cause instanceof Error ? cause.message : 'Could not open that dashboard.',
          );
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
        aria-label={data ? `Dashboard for ${data.tag.label}` : 'Dashboard'}
        onClick={(event) => event.stopPropagation()}
      >
        {error ? (
          <p className="notice error" role="alert">
            {error}
          </p>
        ) : null}

        {data === null ? (
          error ? null : (
            <p className="notice">Loading…</p>
          )
        ) : (
          <>
            <h2 className="dashboard-title">{data.tag.label}</h2>

            {data.truncated ? (
              // Said outright rather than left for someone to wonder about. A
              // total computed over part of the data is worse than no total.
              <p className="notice" role="status">
                This tag holds more than one dashboard reads. The figures below cover the
                most recent entries only.
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
            Close
          </button>
        </div>
      </div>
    </div>
  );
}

/** The headline counts: how much is here, and over what span. */
function Figures({ data }: { data: DashboardView }) {
  const { summary } = data;

  const span =
    summary.firstEvent && summary.lastEvent
      ? summary.firstEvent === summary.lastEvent
        ? dayLabel(new Date(summary.firstEvent))
        : `${dayLabel(new Date(summary.firstEvent))} — ${dayLabel(new Date(summary.lastEvent))}`
      : null;

  return (
    <dl className="figures">
      <Figure label="Verses" value={String(summary.verseCount)} />
      {span ? <Figure label="Span" value={span} /> : null}
      {summary.undatedCount > 0 ? (
        <Figure label="Undated" value={String(summary.undatedCount)} />
      ) : null}
      {summary.deepTimeCount > 0 ? (
        <Figure label="Deep time" value={String(summary.deepTimeCount)} />
      ) : null}
      {summary.mediaCount > 0 ? (
        <Figure
          label="Photos"
          value={`${summary.mediaCount} across ${summary.withMediaCount}`}
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
  const { summary } = data;
  if (summary.ratedCount === 0) return null;

  const peak = Math.max(...summary.ratingHistogram);

  return (
    <section className="dashboard-section">
      <h3>
        Rating <span className="quiet-note">average {summary.averageRating}</span>
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
          {summary.ratedCount} of {summary.verseCount} rated
        </p>
      ) : null}
    </section>
  );
}

/** What the tag's properties add up to — the reason this screen exists. */
function Properties({ data }: { data: DashboardView }) {
  const { summary } = data;
  if (summary.properties.length === 0) return null;

  return (
    <section className="dashboard-section">
      <h3>Properties</h3>
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
                      from {property.numericCount} of {property.verseCount}
                    </span>
                  ) : (
                    <span className="quiet-note"> across {property.verseCount}</span>
                  )}
                </>
              ) : (
                <span className="quiet-note">on {property.verseCount}</span>
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
  const { summary } = data;
  if (summary.coTags.length === 0) return null;

  return (
    <section className="dashboard-section">
      <h3>Also tagged</h3>
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
