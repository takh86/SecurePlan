import pg from "pg";
if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required");
const client = new pg.Client({
  connectionString: process.env.DATABASE_URL,
  connectionTimeoutMillis: 5000,
});
try {
  await client.connect();
  const result = await client.query(
    "SELECT id FROM foundation_probe WHERE id = 1",
  );
  if (result.rowCount !== 1) throw new Error("Missing foundation probe");
  console.log("PostgreSQL connection and foundation migration verified.");
} catch {
  console.error(
    "Database verification failed. Check connection and run migrations.",
  );
  process.exitCode = 1;
} finally {
  await client.end();
}
