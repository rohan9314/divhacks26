import type { Query } from "@mvp/core";
import type { Store, StoredRecord } from "./store";

/**
 * `Store` on Postgres: one row per record in `app.records` (mvp/sql/002). `where` is jsonb
 * containment, which is equality for the flat scalar filters the account logic uses.
 * Uniqueness comes from the partial unique indexes in the migration.
 */
export function createPgStore(query: Query): Store {
  const toRecord = <T>(row: { record_id: string; data: T; created_at: Date | string }): StoredRecord<T> => ({
    recordId: row.record_id,
    data: row.data,
    createdAt: new Date(row.created_at).toISOString(),
  });
  return {
    async create(collection, data) {
      try {
        const { rows } = await query<{ record_id: string }>(
          "INSERT INTO app.records (collection, data) VALUES ($1, $2::jsonb) RETURNING record_id",
          [collection, JSON.stringify(data)],
        );
        return { success: true, data: { recordId: rows[0]?.record_id as string } };
      } catch (error) {
        if ((error as { code?: string }).code === "23505") {
          return { success: false, error: "unique constraint", code: "unique_violation" };
        }
        throw error;
      }
    },
    async update(collection, recordId, data) {
      const { rows } = await query(
        `UPDATE app.records SET data = data || $3::jsonb, updated_at = now()
          WHERE collection = $1 AND record_id = $2 RETURNING record_id`,
        [collection, recordId, JSON.stringify(data)],
      );
      return rows.length ? { success: true, data: { recordId } } : { success: false, error: "not found" };
    },
    async get<T>(collection: string, recordId: string) {
      const { rows } = await query<{ record_id: string; data: T; created_at: string }>(
        "SELECT record_id, data, created_at FROM app.records WHERE collection = $1 AND record_id = $2",
        [collection, recordId],
      );
      const row = rows[0];
      return row
        ? { success: true as const, data: { record: toRecord(row) } }
        : { success: false as const, error: "not found" };
    },
    async query<T>(collection: string, options: { where?: Record<string, unknown>; limit?: number }) {
      const { rows } = await query<{ record_id: string; data: T; created_at: string }>(
        `SELECT record_id, data, created_at FROM app.records
          WHERE collection = $1 AND data @> $2::jsonb
          ORDER BY created_at, record_id LIMIT $3`,
        [collection, JSON.stringify(options.where ?? {}), options.limit ?? 100],
      );
      return { success: true as const, data: { records: rows.map(toRecord) } };
    },
    async remove(collection, recordId) {
      await query("DELETE FROM app.records WHERE collection = $1 AND record_id = $2", [collection, recordId]);
      return { success: true, data: { recordId } };
    },
  };
}
