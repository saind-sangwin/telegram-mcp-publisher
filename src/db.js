import { readFile, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const { Pool } = pg;
const moduleDirectory = dirname(fileURLToPath(import.meta.url));
const defaultMigrationsDirectory = join(moduleDirectory, "..", "migrations");

function asBoolean(value) {
  return /^(1|true|yes)$/i.test(value ?? "");
}

export function createPostgresPool(env = process.env) {
  const connectionString = env.DATABASE_URL?.trim();
  if (!connectionString) throw new Error("DATABASE_URL is not configured.");
  return new Pool({
    connectionString,
    max: Number(env.DATABASE_POOL_MAX ?? 10),
    idleTimeoutMillis: Number(env.DATABASE_IDLE_TIMEOUT_MS ?? 30_000),
    connectionTimeoutMillis: Number(env.DATABASE_CONNECT_TIMEOUT_MS ?? 5_000),
    ssl: asBoolean(env.DATABASE_SSL) ? { rejectUnauthorized: true } : undefined,
  });
}

export async function runMigrations(pool, migrationsDirectory = defaultMigrationsDirectory) {
  await pool.query(
    "CREATE TABLE IF NOT EXISTS schema_migrations (version TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP)",
  );
  const files = (await readdir(migrationsDirectory))
    .filter((file) => /^\d+.*\.sql$/.test(file))
    .sort();
  for (const file of files) {
    const applied = await pool.query(
      "SELECT 1 FROM schema_migrations WHERE version = $1",
      [file],
    );
    if (applied.rowCount) continue;
    const sql = await readFile(join(migrationsDirectory, file), "utf8");
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(sql);
      await client.query("INSERT INTO schema_migrations (version) VALUES ($1)", [file]);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
}

export { defaultMigrationsDirectory };
