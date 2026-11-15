/**
 * The timeline's scale: years from 2000, as a float.
 *
 * One number line holds both a calendar instant and deep time (§2.1), which
 * is what lets "66 million years ago" and "next Tuesday" sort together. The
 * server stores it as `timeline_years` and pages by it; every client arranges
 * what it has loaded by the same number. It lives here because it used to
 * live twice — once in the verse module and once, hand-copied, in the web
 * client — and a locally queued verse sorts into the wrong place the moment
 * the copies disagree.
 */
export const MS_PER_JULIAN_YEAR = 365.25 * 24 * 60 * 60 * 1000;

export const TIMELINE_EPOCH_MS = Date.UTC(2000, 0, 1);

export const yearsFromEpoch = (date: Date): number =>
  (date.getTime() - TIMELINE_EPOCH_MS) / MS_PER_JULIAN_YEAR;
