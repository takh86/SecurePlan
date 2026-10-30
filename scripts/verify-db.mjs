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
  const availability = await client.query(`SELECT
    EXISTS (SELECT 1 FROM schema_migrations WHERE name = '0010_employee_availability.sql')
    AND EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = 'employees'::regclass
      AND attname = 'availability_revision' AND atttypid = 'bigint'::regtype AND attnotnull)
    AND (SELECT count(*) = 2 FROM pg_class WHERE oid IN
      ('employee_availability_days'::regclass, 'availability_batch_commands'::regclass) AND relkind = 'r')
    AND (SELECT count(*) = 2 FROM pg_index WHERE indexrelid IN
      ('uq_employee_availability_days__employee_day'::regclass, 'uq_availability_batch_commands__actor_key'::regclass)
      AND indisunique AND indisvalid) AS valid`);
  if (!availability.rows[0]?.valid) throw new Error("Missing availability integrity catalogue");
  console.log("PostgreSQL connection and foundation migration verified.");
  console.log("SP-10 migration, revision and unique indexes verified.");
} catch {
  console.error(
    "Database verification failed. Check connection and run migrations.",
  );
  process.exitCode = 1;
} finally {
  await client.end();
}
