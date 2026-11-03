/** Reproducible synthetic EXPLAIN; refuses every unverified database target. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir,writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import pg from 'pg';
import { verifyRecordedTestTarget } from './disposable-test-target.mjs';
import { MY_MONTHLY_PLANS_QUERY } from '../apps/backend/dist/modules/planning/me-monthly-plans.query.js';
const verified=await verifyRecordedTestTarget();
assert.ok(process.env.SECUREPLAN_BENCHMARK_OUTPUT_DIR);
const output=resolve(process.env.SECUREPLAN_BENCHMARK_OUTPUT_DIR);await mkdir(output,{recursive:true});
const pool=new pg.Pool({connectionString:process.env.DATABASE_URL});const client=await pool.connect();
const company=randomUUID(),account=randomUUID(),project=randomUUID();
try{
  await client.query('BEGIN');
  await client.query("INSERT INTO companies(id,name,status,time_zone) VALUES($1,'Synthetic SP14 Benchmark','ACTIVE','Europe/Berlin')",[company]);
  await client.query("WITH ids AS (SELECT CASE WHEN n=1 THEN $1::uuid ELSE gen_random_uuid() END AS id FROM generate_series(1,80)n) INSERT INTO accounts(id,company_id,email,account_scope,role,status) SELECT id,$2,id::text||'@example.invalid','TENANT','EMPLOYEE','ACTIVE' FROM ids",[account,company]);
  await client.query("INSERT INTO employees(company_id,account_id,employee_number,first_name,last_name,shift_eligibility) SELECT $1,id,id::text,'Synthetic','Benchmark','BOTH' FROM accounts WHERE company_id=$1",[company]);
  await client.query("INSERT INTO projects(id,company_id,name,status) VALUES($1,$2,'Synthetic Benchmark Project','ACTIVE')",[project,company]);
  await client.query("INSERT INTO monthly_plans(company_id,project_id,planning_month,status,published_at,published_by_account_id) SELECT $1,$2,month::date,'PUBLISHED',clock_timestamp(),$3 FROM generate_series('2021-01-01'::date,'2026-12-01'::date,interval '1 month')month",[company,project,account]);
  await client.query(`INSERT INTO duties(company_id,project_id,monthly_plan_id,planning_month,duty_date,shift_kind,starts_at,ends_at,time_zone,config_effective_from_month,start_local,end_local)
    SELECT $1,$2,m.id,m.planning_month,m.planning_month+n,'TAG',(m.planning_month+n+time '06:00') AT TIME ZONE 'Europe/Berlin',(m.planning_month+n+time '18:00') AT TIME ZONE 'Europe/Berlin','Europe/Berlin',m.planning_month,'06:00','18:00'
    FROM monthly_plans m CROSS JOIN generate_series(0,19)n WHERE m.company_id=$1`,[company,project]);
  await client.query("INSERT INTO plan_assignments(company_id,duty_id,employee_id,duty_function,state) SELECT $1,d.id,e.id,'MITARBEITER','ACTIVE' FROM duties d CROSS JOIN employees e WHERE d.company_id=$1 AND e.company_id=$1",[company]);
  await client.query("INSERT INTO project_assignments(company_id,employee_id,project_id,planning_month) SELECT $1,e.id,$2,'2026-12-01' FROM employees e WHERE e.company_id=$1 AND e.account_id=$3",[company,project,account]);
  for(const table of ['employees','projects','monthly_plans','duties','plan_assignments','project_assignments'])await client.query(`ANALYZE ${table}`);
  const report={cluster:verified.cluster,server:(await client.query('SHOW server_version')).rows[0],scale:{employees:80,months:72,duties:1440,memberships:115200},cases:[]};
  for(const kind of ['membership-heavy','project-link-empty']){
    if(kind==='project-link-empty')await client.query("UPDATE plan_assignments SET state='REMOVED',removed_at=clock_timestamp() WHERE company_id=$1 AND employee_id=(SELECT id FROM employees WHERE company_id=$1 AND account_id=$2)",[company,account]);
    const params=[company,account,'2026-12-01'];
    const rows=(await client.query(MY_MONTHLY_PLANS_QUERY,params)).rows;
    assert.equal(rows.length,kind==='membership-heavy'?20:1);assert.ok(rows.every(row=>row.project_id===project));
    if(kind==='project-link-empty')assert.equal(rows[0].duty_id,null);
    const explain=(await client.query(`EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) ${MY_MONTHLY_PLANS_QUERY}`,params)).rows[0]['QUERY PLAN'][0];
    report.cases.push({kind,rows:rows.length,executionMs:explain['Execution Time'],planningMs:explain['Planning Time'],plan:explain.Plan});
  }
  await writeFile(resolve(output,'explain.json'),JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify({scale:report.scale,cases:report.cases.map(({kind,rows,executionMs,planningMs})=>({kind,rows,executionMs,planningMs}))}));
}finally{await client.query('ROLLBACK');client.release();await pool.end();}
