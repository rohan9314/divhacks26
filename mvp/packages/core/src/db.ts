import pg from "pg";

/** The narrow slice of pg the skills need, so tests can pass a fake. */
export type Query = <R extends Record<string, unknown> = Record<string, unknown>>(
  sql: string,
  values?: unknown[],
) => Promise<{ rows: R[] }>;

export function createPool(databaseUrl: string): pg.Pool {
  // Tiger requires TLS; its connection strings carry sslmode, which pg would apply on top of `ssl`.
  const connectionString = databaseUrl.replace(/[?&]sslmode=[^&]*/g, "");
  return new pg.Pool({ connectionString, max: 4, ssl: { rejectUnauthorized: false } });
}

export function queryFrom(pool: pg.Pool): Query {
  return async (sql, values) => {
    const result = await pool.query(sql, values);
    return { rows: result.rows };
  };
}
