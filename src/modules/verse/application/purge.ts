import { getDatabase } from '@/shared/infra/database';

/**
 * Erases everything this module holds about one person (§8.7).
 *
 * Verses, tags, and the shares granted on either. The join rows and share rows
 * fall to `ON DELETE CASCADE` within this schema, which is allowed precisely
 * because they are this module's own tables — the rule §1.1 forbids is a
 * foreign key *across* schemas.
 *
 * What is deliberately not here is anonymisation of contributed Verses. §8.7
 * decides they are anonymised rather than deleted, but `contribute` is an open
 * decision and the application layer refuses contribute writes, so no Verse can
 * currently exist that one person wrote onto another's tag. See
 * modules/privacy/application/erasure.ts for what landing `contribute` will
 * have to decide — including a real gap in the visibility rule that
 * implementing anonymisation surfaced.
 *
 * Shares *granted to* this person are removed too. Leaving them would keep a
 * row naming a user id that no longer exists, which is an identifier for a
 * person who asked to be forgotten.
 */
export async function purgeForUser(userId: string): Promise<{
  verses: number;
  tags: number;
  shares: number;
}> {
  const db = getDatabase();
  if (!db) throw new Error('verse requires a database; DATABASE_URL is not set');

  const shares =
    (await db.$executeRaw`DELETE FROM verse.verse_share WHERE grantee_id = ${userId}::uuid`) +
    (await db.$executeRaw`DELETE FROM verse.tag_share WHERE grantee_id = ${userId}::uuid`);

  const verses =
    await db.$executeRaw`DELETE FROM verse.verse WHERE owner_id = ${userId}::uuid`;
  const tags =
    await db.$executeRaw`DELETE FROM verse.tag WHERE owner_id = ${userId}::uuid`;

  return { verses, tags, shares };
}
