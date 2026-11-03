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
  // SP-11: the runtime planning guards check the full schema signature; this is the operational smoke check.
  const planning = await client.query(`SELECT
    EXISTS (SELECT 1 FROM schema_migrations WHERE name = '0011_planning_foundation.sql')
    AND (SELECT count(*) = 3 FROM pg_class WHERE oid IN
      ('public.monthly_plans'::regclass, 'public.duties'::regclass, 'public.plan_assignments'::regclass)
      AND relkind = 'r' AND relpersistence = 'p' AND NOT relrowsecurity AND NOT relforcerowsecurity)
    AND (SELECT count(*) = 2 FROM pg_index WHERE indexrelid IN
      ('public.uq_duties__live_slot'::regclass, 'public.uq_plan_assignments__active_employee'::regclass)
      AND indisunique AND indisvalid AND indpred IS NOT NULL) AS valid`);
  if (!planning.rows[0]?.valid) throw new Error("Missing planning integrity catalogue");
  const leases = await client.query(`SELECT
    EXISTS (SELECT 1 FROM schema_migrations WHERE name = '0012_duty_edit_leases.sql')
    AND EXISTS (SELECT 1 FROM pg_class WHERE oid = 'public.edit_leases'::regclass
      AND relkind = 'r' AND relpersistence = 'p' AND NOT relrowsecurity AND NOT relforcerowsecurity)
    AND EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.edit_leases'::regclass
      AND conname = 'uq_edit_leases__duty' AND contype = 'u') AS valid`);
  if (!leases.rows[0]?.valid) throw new Error("Missing edit-lease integrity catalogue");
  const publish = await client.query(`SELECT
    EXISTS (SELECT 1 FROM schema_migrations WHERE name = '0013_initial_publish_idempotency.sql')
    AND EXISTS (SELECT 1 FROM pg_class WHERE oid = 'public.idempotency_records'::regclass
      AND relkind = 'r' AND relpersistence = 'p' AND NOT relrowsecurity AND NOT relforcerowsecurity)
    AND EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.idempotency_records'::regclass
      AND conname = 'uq_idempotency_records__scope' AND contype = 'u') AS valid`);
  if (!publish.rows[0]?.valid) throw new Error("Missing publish idempotency integrity catalogue");
  const calendar = await client.query(`SELECT
    EXISTS (SELECT 1 FROM schema_migrations WHERE name = '0014_project_operating_calendars.sql')
    AND EXISTS (SELECT 1 FROM pg_class WHERE oid = 'public.project_operating_calendars'::regclass
      AND relkind = 'r' AND relpersistence = 'p' AND NOT relrowsecurity AND NOT relforcerowsecurity)
    AND EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.project_operating_calendars'::regclass
      AND contype = 'u' AND pg_get_constraintdef(oid) = 'UNIQUE (company_id, project_id, effective_from_month)') AS valid`);
  if (!calendar.rows[0]?.valid) throw new Error("Missing operating calendar integrity catalogue");
  console.log("PostgreSQL connection and foundation migration verified.");
  console.log("SP-10 migration, revision and unique indexes verified.");
  console.log("SP-11 planning relations and live unique indexes verified.");
  console.log("SP-12 duty edit-lease relation and uniqueness verified.");
  console.log("SP-13 publish idempotency relation and scope uniqueness verified.");
  console.log("A1 operating calendar relation and project/month uniqueness verified.");
} catch {
  console.error(
    "Database verification failed. Check connection and run migrations.",
  );
  process.exitCode = 1;
} finally {
  await client.end();
}
