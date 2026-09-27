/**
 * The record store the account logic runs on. It is the same five-method shape the DeepSpace
 * backend used (create/update/get/query/remove with equality `where`), so the logic ported from
 * backend/src/domain/site.ts runs unchanged on Postgres (pg-store.ts) or in memory (testing.ts).
 */

type Ok<T> = { success: true; data: T };
type Fail = { success: false; error?: string; code?: string };
export type StoreResult<T> = Ok<T> | Fail;

export interface StoredRecord<T> {
  recordId: string;
  data: T;
  createdAt?: string;
}

export interface Store {
  create(collection: string, data: Record<string, unknown>): Promise<StoreResult<{ recordId: string }>>;
  /** Shallow merge of `data` into the record. */
  update(collection: string, recordId: string, data: Record<string, unknown>): Promise<StoreResult<unknown>>;
  get<T>(collection: string, recordId: string): Promise<StoreResult<{ record: StoredRecord<T> }>>;
  query<T>(
    collection: string,
    options: { where?: Record<string, unknown>; limit?: number },
  ): Promise<StoreResult<{ records: StoredRecord<T>[] }>>;
  remove(collection: string, recordId: string): Promise<StoreResult<unknown>>;
}

export interface Row<T> {
  recordId: string;
  data: T;
  createdAt?: string;
}

/** A failure the API turns into `{ error: code }` with a matching HTTP status. */
export class ServiceError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ServiceError";
  }
}

function fail(what: string, error: string | undefined): never {
  throw new Error(`${what} failed: ${error ?? "unknown error"}`);
}

export async function findAll<T>(
  store: Store,
  collection: string,
  where: Record<string, unknown>,
  limit = 500,
): Promise<Row<T>[]> {
  const result = await store.query<T>(collection, { where, limit });
  if (!result.success) fail(`query ${collection}`, result.error);
  return result.data.records.map((r) => ({ recordId: r.recordId, data: r.data, createdAt: r.createdAt }));
}

export async function findOne<T>(
  store: Store,
  collection: string,
  where: Record<string, unknown>,
): Promise<Row<T> | null> {
  const rows = await findAll<T>(store, collection, where, 1);
  return rows[0] ?? null;
}

export async function insert(store: Store, collection: string, data: Record<string, unknown>): Promise<string> {
  const result = await store.create(collection, data);
  if (!result.success) fail(`create ${collection}`, result.error);
  return result.data.recordId;
}

/** Like insert, but a uniqueness clash returns null instead of throwing. */
export async function tryInsert(
  store: Store,
  collection: string,
  data: Record<string, unknown>,
): Promise<string | null> {
  const result = await store.create(collection, data);
  return result.success ? result.data.recordId : null;
}

export async function patch(
  store: Store,
  collection: string,
  recordId: string,
  data: Record<string, unknown>,
): Promise<void> {
  const result = await store.update(collection, recordId, data);
  if (!result.success) fail(`update ${collection}`, result.error);
}
