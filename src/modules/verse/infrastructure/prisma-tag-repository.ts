import { getDatabase } from '@/shared/infra/database';
import { constraintName, isUniqueViolation } from '@/shared/infra/postgres-errors';
import type { CreateTagOutcome, TagRepository } from '../domain/ports';
import type { Tag, Vertical } from '../domain/tag';
import type { Visibility } from '../domain/visibility';

interface TagRow {
  id: string;
  owner_id: string;
  name: string;
  display_name: string | null;
  visibility: string;
  shortcut: string | null;
  vertical: string | null;
  created_at: Date;
  updated_at: Date;
  version: number;
}

/**
 * The casts are safe because the database refuses anything else: the migration
 * constrains `visibility` and `vertical` to closed sets. Re-validating here
 * would be defending against a state the schema makes unreachable, at the cost
 * of a branch nobody can ever exercise in a test.
 */
const toTag = (row: TagRow): Tag => ({
  id: row.id,
  ownerId: row.owner_id,
  name: row.name,
  displayName: row.display_name,
  visibility: row.visibility as Visibility,
  shortcut: row.shortcut,
  vertical: row.vertical as Vertical | null,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  version: row.version,
});

const requireDatabase = () => {
  const db = getDatabase();
  if (!db) {
    // No safe degraded mode: tags carry the visibility a verse inherits, so
    // serving without them would mean guessing at an access decision.
    throw new Error('verse requires a database; DATABASE_URL is not set');
  }
  return db;
};

export class PrismaTagRepository implements TagRepository {
  async findById(id: string): Promise<Tag | null> {
    const rows = await requireDatabase().$queryRaw<TagRow[]>`
      SELECT * FROM verse.tag WHERE id = ${id}::uuid LIMIT 1
    `;
    return rows[0] ? toTag(rows[0]) : null;
  }

  async findByName(ownerId: string, name: string): Promise<Tag | null> {
    const rows = await requireDatabase().$queryRaw<TagRow[]>`
      SELECT * FROM verse.tag
      WHERE owner_id = ${ownerId}::uuid AND name = ${name}
      LIMIT 1
    `;
    return rows[0] ? toTag(rows[0]) : null;
  }

  async findByShortcut(ownerId: string, shortcut: string): Promise<Tag | null> {
    const rows = await requireDatabase().$queryRaw<TagRow[]>`
      SELECT * FROM verse.tag
      WHERE owner_id = ${ownerId}::uuid AND shortcut = ${shortcut}
      LIMIT 1
    `;
    return rows[0] ? toTag(rows[0]) : null;
  }

  /**
   * Scoped to the owner as well as the ids.
   *
   * The owner filter is not redundant with checking ownership afterwards: this
   * is what a caller uses to turn "the tag ids in this request" into tags, and
   * a request naming someone else's tag id must come back with fewer rows than
   * ids rather than with a tag the caller can then act on.
   */
  async findManyByIds(ownerId: string, ids: readonly string[]): Promise<Tag[]> {
    if (ids.length === 0) return [];

    const rows = await requireDatabase().$queryRaw<TagRow[]>`
      SELECT * FROM verse.tag
      WHERE owner_id = ${ownerId}::uuid
        AND id = ANY(${[...ids]}::uuid[])
    `;
    return rows.map(toTag);
  }

  async listForOwner(ownerId: string): Promise<Tag[]> {
    const rows = await requireDatabase().$queryRaw<TagRow[]>`
      SELECT * FROM verse.tag WHERE owner_id = ${ownerId}::uuid ORDER BY name
    `;
    return rows.map(toTag);
  }

  async takenShortcuts(ownerId: string): Promise<Set<string>> {
    const rows = await requireDatabase().$queryRaw<{ shortcut: string }[]>`
      SELECT shortcut FROM verse.tag
      WHERE owner_id = ${ownerId}::uuid AND shortcut IS NOT NULL
    `;
    return new Set(rows.map((r) => r.shortcut));
  }

  /**
   * Insert and let the unique indexes arbitrate, rather than checking first.
   *
   * A SELECT-then-INSERT has a window in which another request slips in, and
   * the loser gets a raw driver error instead of the outcome the caller asked
   * for. Which index failed is the difference between "you already have that
   * tag" and "that shortcut is taken", so the constraint name is read rather
   * than collapsed to a boolean.
   */
  async create(tag: Tag): Promise<CreateTagOutcome> {
    try {
      await requireDatabase().$executeRaw`
        INSERT INTO verse.tag
          (id, owner_id, name, display_name, visibility, shortcut, vertical,
           created_at, updated_at, version)
        VALUES (
          ${tag.id}::uuid,
          ${tag.ownerId}::uuid,
          ${tag.name},
          ${tag.displayName},
          ${tag.visibility},
          ${tag.shortcut},
          ${tag.vertical},
          ${tag.createdAt},
          ${tag.updatedAt},
          ${tag.version}
        )
      `;
      return { kind: 'created' };
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;

      const constraint = constraintName(error) ?? '';
      if (constraint.includes('shortcut')) return { kind: 'shortcut-taken' };
      if (constraint.includes('name')) return { kind: 'name-taken' };

      // A unique violation on this table that names neither index is a
      // constraint nobody here knows about. Re-throwing beats guessing: a wrong
      // guess would report a friendly message for a bug that needs fixing.
      throw error;
    }
  }

  async update(tag: Tag, expectedVersion: number): Promise<boolean> {
    const updated = await requireDatabase().$executeRaw`
      UPDATE verse.tag
      SET name = ${tag.name},
          display_name = ${tag.displayName},
          visibility = ${tag.visibility},
          shortcut = ${tag.shortcut},
          vertical = ${tag.vertical},
          updated_at = ${tag.updatedAt},
          version = version + 1
      WHERE id = ${tag.id}::uuid
        AND version = ${expectedVersion}
    `;
    return updated > 0;
  }

  /**
   * Deleting a tag cascades to `verse_tag`, which can leave a verse with no
   * tags at all. That is a domain rule the database cannot express (a CHECK
   * cannot see another table), so the application layer refuses the delete
   * while any verse would be orphaned — see `delete-tag.ts`.
   */
  async delete(id: string, expectedVersion: number): Promise<boolean> {
    const deleted = await requireDatabase().$executeRaw`
      DELETE FROM verse.tag
      WHERE id = ${id}::uuid AND version = ${expectedVersion}
    `;
    return deleted > 0;
  }
}
