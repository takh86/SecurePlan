import { readdir, readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import pg from "pg";
// Checksums cover the exact file bytes, so a Git checkout that rewrites line
// endings (core.autocrlf) changes them. That stays a hard failure; the report
// only names the file and whether the bytes differ solely in line endings.
class ChecksumMismatch extends Error {}
const sha256 = (text) => createHash("sha256").update(text).digest("hex");
function lineEndingOnly(sql, recorded) {
  const lf = sql.replace(/\r\n/g, "\n");
  return sha256(lf) === recorded || sha256(lf.replace(/\n/g, "\r\n")) === recorded;
}
if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required");
const client = new pg.Client({
  connectionString: process.env.DATABASE_URL,
  connectionTimeoutMillis: 5000,
});
let locked = false;
try {
  await client.connect();
  await client.query("SELECT pg_advisory_lock(731042601)");
  locked = true;
  await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
    name text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now()
  )`);
  const dir = new URL("../apps/backend/migrations/", import.meta.url);
  for (const name of (await readdir(dir))
    .filter((n) => /^\d+.*\.sql$/.test(n))
    .sort()) {
    const sql = await readFile(new URL(name, dir), "utf8");
    const checksum = sha256(sql);
    const prior = await client.query(
      "SELECT checksum FROM schema_migrations WHERE name = $1",
      [name],
    );
    if (prior.rowCount) {
      if (prior.rows[0].checksum !== checksum)
        throw new ChecksumMismatch(
          lineEndingOnly(sql, prior.rows[0].checksum)
            ? `Applied migration ${name} differs from the ledger only in line endings (CRLF/LF). ` +
              "Restore the recorded bytes in the working tree; do not edit the ledger. See docs/docker.md."
            : `Applied migration ${name} does not match its recorded checksum.`,
        );
      console.log(`Already applied: ${name}`);
      continue;
    }
    await client.query("BEGIN");
    try {
      await client.query(sql);
      await client.query(
        "INSERT INTO schema_migrations(name, checksum) VALUES ($1, $2)",
        [name, checksum],
      );
      await client.query("COMMIT");
      console.log(`Applied: ${name}`);
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    }
  }
} catch (error) {
  // Database errors can contain credentials or SQL values. Keep CLI output neutral;
  // a checksum report names only the file.
  if (error instanceof ChecksumMismatch) console.error(error.message);
  console.error(
    "Migration failed. Check database availability and immutable migration files.",
  );
  process.exitCode = 1;
} finally {
  if (locked)
    await client.query("SELECT pg_advisory_unlock(731042601)").catch(() => {});
  await client.end();
}
