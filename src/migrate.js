import { createPostgresPool, runMigrations } from "./db.js";

const pool = createPostgresPool();
try {
  await runMigrations(pool);
  console.log("PostgreSQL migrations are up to date.");
} finally {
  await pool.end();
}
