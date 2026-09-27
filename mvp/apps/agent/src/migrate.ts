import "dotenv/config";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createPool } from "@mvp/core";

// Applies mvp/sql/*.sql in order. Every file is idempotent (IF NOT EXISTS), so reruns are safe.
// For hosts without psql; on the droplet `docker compose run --rm migrate` does the same.
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is not set");

const dir = join(import.meta.dirname, "../../../sql");
const pool = createPool(databaseUrl);
try {
  for (const file of readdirSync(dir)
    .filter((name) => name.endsWith(".sql"))
    .sort()) {
    console.log(`Applying sql/${file}`);
    await pool.query(readFileSync(join(dir, file), "utf8"));
  }
} finally {
  await pool.end();
}
