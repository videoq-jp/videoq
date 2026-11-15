import {createHash,randomUUID} from 'node:crypto';
import {TLSSocket,checkServerIdentity} from 'node:tls';
import type pg from 'pg';
import {z} from 'zod';
const name=z.string().min(1).max(63).refine(value=>!value.includes('\0'));
const targetSchema=z.discriminatedUnion('purpose',[
 z.object({purpose:z.literal('production'),host:z.literal('ep-old-truth-a1co51ud.ap-southeast-1.aws.neon.tech'),databaseName:z.literal('neondb'),rolePrefix:z.literal('videoq_')}).strict(),
 z.object({purpose:z.literal('isolated-rehearsal'),host:z.enum(['localhost','127.0.0.1','::1']),databaseName:z.string().regex(/^recovery_[a-f0-9]{32}$/),rolePrefix:z.string().regex(/^recovery_[a-f0-9]{32}_$/)}).strict(),
]).refine(t=>t.purpose==='production'||t.rolePrefix===t.databaseName+'_');
const roleSchema=z.object({oid:z.number().int().positive(),name,can_login:z.boolean(),superuser:z.boolean(),create_db:z.boolean(),create_role:z.boolean(),replication:z.boolean(),bypass_rls:z.boolean(),inherit:z.boolean(),connection_limit:z.number().int(),valid_until:z.string().nullable()}).strict();
const memberSchema=z.object({roleid:z.number().int(),member:z.number().int(),grantor:z.number().int(),admin_option:z.boolean(),inherit_option:z.boolean(),set_option:z.boolean()}).strict();
export const postgresLoginFencePlanSchema=z.object({version:z.literal(1),operationId:z.uuid(),target:targetSchema,roles:z.array(roleSchema).min(1).max(200),memberships:z.array(memberSchema),catalogSha256:z.string().regex(/^[a-f0-9]{64}$/)}).strict();
export type PostgresLoginFenceTarget=z.infer<typeof targetSchema>;
export type PostgresLoginFencePlan=z.infer<typeof postgresLoginFencePlanSchema>;
type Role=z.infer<typeof roleSchema>;
const quote=(value:string)=>'"'+value.replaceAll('"','""')+'"';
const hash=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const fail=(message:string):never=>{throw new Error(message);};
const reader=(role:string,prefix:string)=>role.startsWith(prefix+'backup_')||role.startsWith(prefix+'audit_');
const writerNames=(p:PostgresLoginFencePlan)=>p.roles.filter(r=>r.can_login&&!reader(r.name,p.target.rolePrefix)).map(r=>r.name);
async function identity(client:pg.Client,raw:PostgresLoginFenceTarget){
 const t=targetSchema.parse(raw);
 if(client.host!==t.host||client.database!==t.databaseName)fail('PostgreSQL fence connection target mismatch.');
 if(t.purpose==='production'){
  const stream=client.connection.stream;
  if(!(stream instanceof TLSSocket)||!stream.authorized||checkServerIdentity(t.host,stream.getPeerCertificate()))fail('Verified direct Neon TLS connection required.');
 }
 const row=(await client.query<{database:string;current_user:string;session_user:string}>("SELECT current_database() AS database,current_user,session_user")).rows[0];
 if(row.database!==t.databaseName||row.current_user!==row.session_user||row.session_user.startsWith(t.rolePrefix))fail('Independent administration identity required.');
 return t;
}
async function catalog(client:pg.Client,prefix:string){
 const roles=z.array(roleSchema).parse((await client.query(`SELECT oid::int AS oid,rolname AS name,rolcanlogin AS can_login,rolsuper AS superuser,rolcreatedb AS create_db,rolcreaterole AS create_role,rolreplication AS replication,rolbypassrls AS bypass_rls,rolinherit AS inherit,rolconnlimit AS connection_limit,rolvaliduntil::text AS valid_until FROM pg_roles WHERE left(rolname,length($1))=$1 ORDER BY rolname COLLATE "C"`,[prefix])).rows);
 if(!roles.length||roles.length>200)fail('Bounded managed role inventory required.');
 const ids=roles.map(r=>r.oid),memberships=z.array(memberSchema).parse((await client.query('SELECT roleid::int,member::int,grantor::int,admin_option,inherit_option,set_option FROM pg_auth_members WHERE roleid=ANY($1::oid[]) OR member=ANY($1::oid[]) ORDER BY roleid,member,grantor',[ids])).rows);
 return {roles,memberships};
}
function digest(roles:Role[],memberships:PostgresLoginFencePlan['memberships'],writers:string[]){
 return hash({roles:roles.map(r=>({...r,can_login:writers.includes(r.name)?null:r.can_login})),memberships});
}
/** Readers remain usable for final backup; prove ACL/role denial independently
 * of default_transaction_read_only. Unknown SECURITY DEFINER access is rejected. */
async function assertReaders(client:pg.Client,prefix:string,roles:Role[]){
 // An unrecognized low-privilege LOGIN with write access must not silently
 // escape the managed prefix. Privileged provider/admin identities are outside
 // this application fence and require the external maintenance lock.
 const outsiders=z.array(roleSchema).parse((await client.query(`SELECT oid::int AS oid,rolname AS name,rolcanlogin AS can_login,rolsuper AS superuser,rolcreatedb AS create_db,rolcreaterole AS create_role,rolreplication AS replication,rolbypassrls AS bypass_rls,rolinherit AS inherit,rolconnlimit AS connection_limit,rolvaliduntil::text AS valid_until FROM pg_roles WHERE rolcanlogin AND left(rolname,length($1))<>$1 AND rolname<>session_user AND NOT (rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls) ORDER BY rolname COLLATE "C"`,[prefix])).rows);
 for(const role of [...roles.filter(r=>r.can_login&&reader(r.name,prefix)),...outsiders]){
  const row=(await client.query<{unsafe:boolean}>(`SELECT
   EXISTS(SELECT 1 FROM pg_roles r WHERE pg_has_role($1::oid,r.oid,'MEMBER') AND (r.rolsuper OR r.rolcreatedb OR r.rolcreaterole OR r.rolreplication OR r.rolbypassrls))
   OR EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE left(n.nspname,3)<>'pg_' AND n.nspname<>'information_schema' AND CASE WHEN c.relkind IN ('r','p','v','m','f') THEN has_table_privilege($1::oid,c.oid,'INSERT,UPDATE,DELETE,TRUNCATE,TRIGGER') ELSE false END)
   OR EXISTS(SELECT 1 FROM pg_namespace n WHERE left(n.nspname,3)<>'pg_' AND n.nspname<>'information_schema' AND has_schema_privilege($1::oid,n.oid,'CREATE'))
   OR EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE left(n.nspname,3)<>'pg_' AND n.nspname<>'information_schema' AND CASE WHEN c.relkind='S' THEN has_sequence_privilege($1::oid,c.oid,'USAGE,UPDATE') ELSE false END)
   OR EXISTS(SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE left(n.nspname,3)<>'pg_' AND n.nspname<>'information_schema' AND p.prosecdef AND has_schema_privilege($1::oid,n.oid,'USAGE') AND has_function_privilege($1::oid,p.oid,'EXECUTE')) AS unsafe`,[role.oid])).rows[0];
  if(row.unsafe)fail(role.name.startsWith(prefix)?'Retained backup/audit login has possible write authority.':'Unmanaged login has possible write authority.');
 }
}
async function activity(client:pg.Client,writers:string[]){
 return (await client.query<{writers:number;other_databases:number;unknown:number;prepared:number}>(`SELECT
  (SELECT count(*)::int FROM pg_stat_activity WHERE datname=current_database() AND usename=ANY($1::text[]) AND pid<>pg_backend_pid()) AS writers,
  (SELECT count(*)::int FROM pg_stat_activity WHERE datname<>current_database() AND usename=ANY($1::text[])) AS other_databases,
  (SELECT count(*)::int FROM pg_stat_activity WHERE backend_type='client backend' AND (usename IS NULL OR datname IS NULL)) AS unknown,
  (SELECT count(*)::int FROM pg_prepared_xacts WHERE database=current_database()) AS prepared`,[writers])).rows[0];
}
/** Read-only preparation. Persist plan before install; hold the external global
 * maintenance/rotation lock for the ENTIRE fenced interval. */
export async function preparePostgresLoginFence(client:pg.Client,target:PostgresLoginFenceTarget){
 const t=await identity(client,target),c=await catalog(client,t.rolePrefix);
 const writers=c.roles.filter(r=>r.can_login&&!reader(r.name,t.rolePrefix)).map(r=>r.name);
 if(!writers.length)fail('No active managed writer logins; do not replace an existing fence plan.');
 await assertReaders(client,t.rolePrefix,c.roles);
 const a=await activity(client,writers);if(a.other_databases||a.prepared)fail('Cross-database sessions or prepared transactions require reconciliation.');
 return postgresLoginFencePlanSchema.parse({version:1,operationId:randomUUID(),target:t,...c,catalogSha256:digest(c.roles,c.memberships,writers)});
}
export async function inspectPostgresLoginFence(client:pg.Client,raw:PostgresLoginFencePlan){
 const p=postgresLoginFencePlanSchema.parse(raw),writers=writerNames(p);
 if(!writers.length||digest(p.roles,p.memberships,writers)!==p.catalogSha256)fail('Invalid PostgreSQL fence plan.');
 await identity(client,p.target);const c=await catalog(client,p.target.rolePrefix);
 if(digest(c.roles,c.memberships,writers)!==p.catalogSha256)fail('Managed role or membership drift.');
 await assertReaders(client,p.target.rolePrefix,c.roles);
 const active=c.roles.filter(r=>writers.includes(r.name)&&r.can_login).length,a=await activity(client,writers);
 return {state:active===writers.length?'open' as const:active===0&&a.writers===0&&a.prepared===0&&a.unknown===0&&a.other_databases===0?'fenced' as const:'incomplete' as const,writerLogins:writers.length,enabledWriterLogins:active,writerSessions:a.writers,otherDatabaseSessions:a.other_databases,unknownSessions:a.unknown,preparedTransactions:a.prepared};
}
async function alterLogins(client:pg.Client,p:PostgresLoginFencePlan,enable:boolean){
 await client.query('BEGIN');
 try{
  await client.query("SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='30s'");
  const locked=(await client.query<{locked:boolean}>('SELECT pg_try_advisory_xact_lock(hashtext($1),hashtext($2)) AS locked',['videoq-login-fence',p.target.rolePrefix])).rows[0].locked;
  if(!locked)fail('Another fenced operation holds the PostgreSQL fence lock.');
  const observed=await inspectPostgresLoginFence(client,p);
  if(observed.otherDatabaseSessions||observed.preparedTransactions)fail('Cross-database sessions or prepared transactions require reconciliation.');
  for(const login of writerNames(p))await client.query('ALTER ROLE '+quote(login)+(enable?' LOGIN':' NOLOGIN'));
  await client.query('COMMIT');
 }catch(error){await client.query('ROLLBACK');throw error;}
}
/** NOLOGIN alone does NOT stop existing sessions. Commit it first, terminate
 * managed writers (including active transactions), then verify real absence. */
export async function installPostgresLoginFence(client:pg.Client,raw:PostgresLoginFencePlan,upstreamStopped:boolean){
 const p=postgresLoginFencePlanSchema.parse(raw);
 if(!upstreamStopped)fail('Externally stopped producers and maintenance operations required.');
 await alterLogins(client,p,false);
 await client.query('SELECT pg_terminate_backend(pid,5000) FROM pg_stat_activity WHERE datname=current_database() AND usename=ANY($1::text[]) AND pid<>pg_backend_pid()',[writerNames(p)]);
 const verified=await inspectPostgresLoginFence(client,p);
 if(verified.state!=='fenced')fail('PostgreSQL fence incomplete; preserve NOLOGIN and keep upstream stopped.');
 return verified;
}
/** Restore only logins that were enabled in the prepared plan. Never reset a
 * password, grant, membership, expiry, or previously retired NOLOGIN role. */
export async function releasePostgresLoginFence(client:pg.Client,raw:PostgresLoginFencePlan,upstreamStopped:boolean){
 const p=postgresLoginFencePlanSchema.parse(raw);
 if(!upstreamStopped)fail('Externally stopped producers and maintenance operations required.');
 await alterLogins(client,p,true);const verified=await inspectPostgresLoginFence(client,p);
 if(verified.state!=='open')fail('PostgreSQL release incomplete; keep upstream stopped.');return verified;
}
export {targetSchema as postgresLoginFenceTargetSchema};
