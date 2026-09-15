import { ListObjectsV2Command, S3Client } from '@aws-sdk/client-s3';
import { loadConfig } from './config';

/**
 * How recently the last backup ran.
 *
 * This exists because six consecutive nightly backups failed and nothing said
 * so. `pg_dump` was refusing to dump a server newer than itself, the job exited
 * 1 every night, and every signal pointed the other way: Cloud Scheduler reads
 * a non-2xx as a retry rather than an alert, `/v1/health` reported the database
 * and R2 both ok, and the status table's ☐ read as "not built yet" when it
 * meant "running and failing". architecture.md §8.8 calls an untested backup a
 * guess; an unwatched one is the same thing with extra steps.
 *
 * Deliberately *not* behind the ObjectStorage port. That adapter prefixes every
 * key with `R2_PREFIX`, which exists so preview environments can share one
 * bucket — and the backup job does not go through it: it writes with its own
 * client at the bucket root under `backups/`. Reading backups through the app's
 * adapter would look under `pr-21/backups/` on a preview and find nothing,
 * reporting a missing backup that was never supposed to be there.
 */

/** Matches `BACKUP_PREFIX`'s default in infra/backup/backup.mjs. */
const BACKUP_PREFIX = 'backups/';

/**
 * How old the newest backup may be before this is worth saying out loud.
 *
 * The job runs at 03:17 UTC daily, so 24 hours is the expected gap and anything
 * under about 26 is normal jitter. 36 gives a night's grace — one missed run is
 * worth knowing about, and this should not cry wolf over a run that started
 * late.
 */
export const BACKUP_STALE_AFTER_MS = 36 * 60 * 60 * 1000;

export interface BackupFreshness {
  /** The newest backup's timestamp, or null when no backup exists at all. */
  readonly newest: Date | null;
  readonly stale: boolean;
}

/**
 * The key the backup job writes, as at a given instant.
 *
 * Mirrors `infra/backup/backup.mjs` exactly — `backups/YYYY/MM/agnte-<ISO with
 * : and . replaced by ->.dump`. Two properties of that layout are load-bearing
 * here: it sorts lexicographically in time order (zero-padded, most significant
 * first, including across month and year boundaries — "2027/01" sorts after
 * "2026/12"), and it carries its own timestamp, so the age of a backup can be
 * read from its name without fetching the object.
 */
function keyAt(at: Date): string {
  const year = at.getUTCFullYear();
  const month = String(at.getUTCMonth() + 1).padStart(2, '0');
  const stamp = at.toISOString().replace(/[:.]/g, '-');
  return `${BACKUP_PREFIX}${year}/${month}/agnte-${stamp}.dump`;
}

/** Reads back the instant a key encodes, or null if it is not one of ours. */
export function timestampFromKey(key: string): Date | null {
  const match =
    /agnte-(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z\.dump$/.exec(key);
  if (!match) return null;

  const [, y, mo, d, h, mi, s, ms] = match;
  const at = new Date(`${y}-${mo}-${d}T${h}:${mi}:${s}.${ms}Z`);
  return Number.isNaN(at.getTime()) ? null : at;
}

function client(): S3Client | null {
  const config = loadConfig();
  if (
    !config.R2_ENDPOINT ||
    !config.R2_BUCKET ||
    !config.R2_ACCESS_KEY_ID ||
    !config.R2_SECRET_ACCESS_KEY
  ) {
    return null;
  }

  return new S3Client({
    region: 'auto',
    endpoint: config.R2_ENDPOINT,
    credentials: {
      accessKeyId: config.R2_ACCESS_KEY_ID,
      secretAccessKey: config.R2_SECRET_ACCESS_KEY,
    },
  });
}

/**
 * Is there a backup newer than the cutoff, and if not, how old is the newest?
 *
 * The happy path is one `ListObjectsV2` returning at most one key: `StartAfter`
 * is the key the job *would* have written at the cutoff instant, so the
 * question "is anything newer than that" becomes a single bounded listing
 * rather than a walk of every backup ever taken. That matters — this runs on a
 * health endpoint, and a check that paged through a year of objects on every
 * poll would be its own cost problem (architecture.md §3.1).
 *
 * Only the unhappy path pays more: when nothing is newer than the cutoff, the
 * current and previous month are listed to say *how* stale, because "no backup
 * for 4 days" is worth acting on in a way that "no backup since <cutoff>" is
 * not. Two extra listings on a day something is already wrong is a fair price.
 */
export async function backupFreshness(now: Date): Promise<BackupFreshness | null> {
  const s3 = client();
  if (!s3) return null;

  const { R2_BUCKET: bucket } = loadConfig();
  const cutoff = new Date(now.getTime() - BACKUP_STALE_AFTER_MS);

  const fresh = await s3.send(
    new ListObjectsV2Command({
      Bucket: bucket,
      Prefix: BACKUP_PREFIX,
      StartAfter: keyAt(cutoff),
      MaxKeys: 1,
    }),
  );

  const newestFresh = fresh.Contents?.[0]?.Key;
  if (newestFresh) {
    return { newest: timestampFromKey(newestFresh) ?? cutoff, stale: false };
  }

  // Stale, or empty. Look back over this month and last to date it.
  const months = [
    now,
    new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1)),
  ];

  let newest: Date | null = null;
  for (const month of months) {
    const listing = await s3.send(
      new ListObjectsV2Command({
        Bucket: bucket,
        Prefix: `${BACKUP_PREFIX}${month.getUTCFullYear()}/${String(
          month.getUTCMonth() + 1,
        ).padStart(2, '0')}/`,
      }),
    );

    for (const object of listing.Contents ?? []) {
      const at = object.Key ? timestampFromKey(object.Key) : null;
      if (at && (newest === null || at > newest)) newest = at;
    }

    // Newest first: if this month held anything, last month cannot beat it.
    if (newest) break;
  }

  return { newest, stale: true };
}
