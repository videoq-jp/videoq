import {randomUUID} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {describe,it,expect} from 'vitest';
import pg from 'pg';
import {openPrivateInput} from '../../scripts/migrations/d1/private-input';
import {preparePostgresLoginFence,inspectPostgresLoginFence,installPostgresLoginFence,releasePostgresLoginFence,type PostgresLoginFenceTarget} from '../../scripts/migrations/d1/postgres-login-fence';
const url=process.env.PERSISTENCE_TEST_DATABASE_URL;
const quote=(s:string)=>'"'+s.replaceAll('"','""')+'"';
async function fixture(){
 const source=new URL(url!),database='recovery_'+randomUUID().replaceAll('-',''),prefix=database+'_',password=randomUUID().replaceAll('-','');
 if(!['localhost','127.0.0.1','[::1]','::1'].includes(source.hostname))throw new Error('Login-fence test requires a loopback disposable server.');
 const admin=new pg.Client({connectionString:url});await admin.connect();await admin.query('CREATE DATABASE '+quote(database));source.pathname='/'+database;
 const connectionString=source.toString(),client=new pg.Client({connectionString});await client.connect();
 const roles={api:prefix+'api',smoke:prefix+'smoke',backup:prefix+'backup_1',retired:prefix+'retired',group:prefix+'access',quoted:prefix+'quoted"login'};
 const held:pg.Client[]=[];
 async function connectAs(name:string){const u=new URL(connectionString);u.username=name;u.password=password;const c=new pg.Client({connectionString:u.toString()});c.on('error',()=>{});held.push(c);await c.connect();return c;}
 try{
  for(const [key,name] of Object.entries(roles))await client.query('CREATE ROLE '+quote(name)+(key==='retired'||key==='group'?' NOLOGIN':' LOGIN')+" NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD '"+password+"'");
  await client.query('CREATE TABLE public.fence_probe(value integer); GRANT USAGE ON SCHEMA public TO '+Object.values(roles).map(quote).join(','));
  await client.query('GRANT SELECT,INSERT,UPDATE,DELETE ON public.fence_probe TO '+quote(roles.group)+'; GRANT '+quote(roles.group)+' TO '+quote(roles.api));
  await client.query('GRANT SELECT ON public.fence_probe TO '+quote(roles.backup));
  await client.query("CREATE FUNCTION public.fence_smoke() RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,public AS 'INSERT INTO public.fence_probe VALUES (99)'; REVOKE ALL ON FUNCTION public.fence_smoke() FROM PUBLIC; GRANT EXECUTE ON FUNCTION public.fence_smoke() TO "+quote(roles.smoke));
  const target={purpose:'isolated-rehearsal',host:client.host,databaseName:database,rolePrefix:prefix} as PostgresLoginFenceTarget;
  return {client,roles,target,connectAs,connectionString,password,async dispose(){for(const c of held)await c.end().catch(()=>{});await client.end();await admin.query('DROP DATABASE '+quote(database)+' WITH (FORCE)');for(const role of Object.values(roles))await admin.query('DROP ROLE '+quote(role));await admin.end();}};
 }catch(error){await client.end();await admin.query('DROP DATABASE '+quote(database)+' WITH (FORCE)');for(const role of Object.values(roles))await admin.query('DROP ROLE IF EXISTS '+quote(role));await admin.end();throw error;}
}
describe.skipIf(!url)('PostgreSQL managed-login fence',()=>{
 it('persists a private plan and keeps the fence across independent operator processes, rejecting wrong destinations and confirmations',async()=>{
  const f=await fixture(),directory=await mkdtemp(join(tmpdir(),'videoq-login-fence-'));
  try{
   const target=join(directory,'target.json'),state=join(directory,'state.json');await writeFile(target,JSON.stringify(f.target),{mode:0o600});
   const env={...process.env};for(const key of Object.keys(env))if(!['PATH','HOME','TMPDIR','LANG'].includes(key))delete env[key];env.VIDEOQ_FENCE_ADMIN_DATABASE_URL=f.connectionString;env.VIDEOQ_MIGRATION_UPSTREAM_STOPPED='1';
   const command=(args:string[],vars=env)=>promisify(execFile)(process.execPath,['--import','tsx',resolve('scripts/d1-postgres-login-fence.ts'),...args],{env:vars,timeout:20000,maxBuffer:1024**2,encoding:'utf8'});
   expect(JSON.parse((await command(['--mode','prepare','--target',target,'--state',state])).stdout).prepared).toBe(true);
   const input=await openPrivateInput(state,1024**2);try{expect(input.info.mode&0o077).toBe(0);expect(await input.file.readFile('utf8')).not.toContain(f.password);}finally{await input.file.close();}
   await expect(command(['--mode','install','--state',state,'--confirm-database','wrong_database'])).rejects.toMatchObject({code:1});
   expect((await f.client.query('SELECT rolcanlogin FROM pg_roles WHERE rolname=$1',[f.roles.api])).rows[0].rolcanlogin).toBe(true);
   expect(JSON.parse((await command(['--mode','install','--state',state,'--confirm-database',f.target.databaseName])).stdout).state).toBe('fenced');
   await expect(f.connectAs(f.roles.api)).rejects.toMatchObject({code:'28000'});
   const wrong=new URL(f.connectionString);wrong.hostname='attacker.invalid';
   await expect(command(['--mode','inspect','--state',state],{...env,VIDEOQ_FENCE_ADMIN_DATABASE_URL:wrong.toString()})).rejects.toMatchObject({code:1});
   expect(JSON.parse((await command(['--mode','inspect','--state',state])).stdout).state).toBe('fenced');
   expect(JSON.parse((await command(['--mode','release','--state',state,'--confirm-database',f.target.databaseName])).stdout).state).toBe('open');
   const api=await f.connectAs(f.roles.api);await api.query('INSERT INTO public.fence_probe VALUES (3)');
   await expect(f.connectAs(f.roles.retired)).rejects.toMatchObject({code:'28000'});
  }finally{await rm(directory,{recursive:true,force:true});await f.dispose();}
 },90000);

 it('stops new logins and existing transactions including SECURITY DEFINER callers, retaining ACL-readonly backups and retired roles',async()=>{
  const f=await fixture();try{
   const active=await f.connectAs(f.roles.api),smoke=await f.connectAs(f.roles.smoke),backup=await f.connectAs(f.roles.backup);
   await active.query('BEGIN; INSERT INTO public.fence_probe VALUES (1)');await smoke.query('SELECT 1');await backup.query('SET default_transaction_read_only=off');
   const plan=await preparePostgresLoginFence(f.client,f.target);expect((await inspectPostgresLoginFence(f.client,plan)).state).toBe('open');
   await expect(installPostgresLoginFence(f.client,plan,false)).rejects.toThrow('Externally stopped');
   const fenced=await installPostgresLoginFence(f.client,plan,true);expect(fenced.state).toBe('fenced');expect(fenced.writerLogins).toBe(3);expect(fenced.writerSessions).toBe(0);
   await expect(active.query('COMMIT')).rejects.toThrow();await expect(smoke.query('SELECT public.fence_smoke()')).rejects.toThrow();
   await expect(f.connectAs(f.roles.api)).rejects.toMatchObject({code:'28000'});await expect(f.connectAs(f.roles.smoke)).rejects.toMatchObject({code:'28000'});
   expect((await backup.query('SELECT count(*)::int n FROM public.fence_probe')).rows[0].n).toBe(0);
   await expect(backup.query('INSERT INTO public.fence_probe VALUES (5)')).rejects.toMatchObject({code:'42501'});
   expect((await installPostgresLoginFence(f.client,plan,true)).state).toBe('fenced');expect((await releasePostgresLoginFence(f.client,plan,true)).state).toBe('open');expect((await releasePostgresLoginFence(f.client,plan,true)).state).toBe('open');
   const resumed=await f.connectAs(f.roles.api);await resumed.query('INSERT INTO public.fence_probe VALUES (2)');expect((await backup.query('SELECT count(*)::int n FROM public.fence_probe')).rows[0].n).toBe(1);
   await expect(f.connectAs(f.roles.retired)).rejects.toMatchObject({code:'28000'});
  }finally{await f.dispose();}
 },60000);
 it('refuses writable backup capabilities, role drift and prepared transactions without changing original login flags',async()=>{
  const f=await fixture();const extra=f.target.rolePrefix+'extra';let created=false;try{
   await f.client.query('GRANT EXECUTE ON FUNCTION public.fence_smoke() TO '+quote(f.roles.backup));await expect(preparePostgresLoginFence(f.client,f.target)).rejects.toThrow('possible write authority');await f.client.query('REVOKE EXECUTE ON FUNCTION public.fence_smoke() FROM '+quote(f.roles.backup));
   await f.client.query('GRANT '+quote(f.roles.group)+' TO '+quote(f.roles.backup));await expect(preparePostgresLoginFence(f.client,f.target)).rejects.toThrow('possible write authority');await f.client.query('REVOKE '+quote(f.roles.group)+' FROM '+quote(f.roles.backup));
   const outsider='fence_outsider_'+randomUUID().replaceAll('-','');await f.client.query('CREATE ROLE '+quote(outsider)+' LOGIN');
   try{await f.client.query('GRANT INSERT ON public.fence_probe TO '+quote(outsider));await expect(preparePostgresLoginFence(f.client,f.target)).rejects.toThrow('Unmanaged login');}
   finally{await f.client.query('REVOKE ALL ON public.fence_probe FROM '+quote(outsider));await f.client.query('DROP ROLE '+quote(outsider));}
   const plan=await preparePostgresLoginFence(f.client,f.target);await expect(installPostgresLoginFence(f.client,{...plan,target:{...f.target,databaseName:'recovery_'+'0'.repeat(32)}},true)).rejects.toThrow();
   await f.client.query('CREATE ROLE '+quote(extra)+' LOGIN');created=true;await expect(installPostgresLoginFence(f.client,plan,true)).rejects.toThrow('role or membership drift');expect((await f.client.query('SELECT rolcanlogin FROM pg_roles WHERE rolname=$1',[f.roles.api])).rows[0].rolcanlogin).toBe(true);await f.client.query('DROP ROLE '+quote(extra));created=false;
   if(process.env.PERSISTENCE_TEST_PREPARED_TRANSACTIONS==='1'){
    expect(Number((await f.client.query('SHOW max_prepared_transactions')).rows[0].max_prepared_transactions)).toBeGreaterThan(0);
    const api=await f.connectAs(f.roles.api),transaction='fence_'+randomUUID().replaceAll('-','');await api.query("BEGIN; INSERT INTO public.fence_probe VALUES (7); PREPARE TRANSACTION '"+transaction+"'");
    try{await expect(preparePostgresLoginFence(f.client,f.target)).rejects.toThrow('prepared transactions');await expect(installPostgresLoginFence(f.client,plan,true)).rejects.toThrow('prepared transactions');}
    finally{await f.client.query("ROLLBACK PREPARED '"+transaction+"'");}
   }
   expect((await installPostgresLoginFence(f.client,plan,true)).state).toBe('fenced');await f.client.query('CREATE ROLE '+quote(extra)+' LOGIN');created=true;await expect(releasePostgresLoginFence(f.client,plan,true)).rejects.toThrow('role or membership drift');expect((await f.client.query('SELECT rolcanlogin FROM pg_roles WHERE rolname=$1',[f.roles.api])).rows[0].rolcanlogin).toBe(false);await f.client.query('DROP ROLE '+quote(extra));created=false;await releasePostgresLoginFence(f.client,plan,true);
  }finally{if(created)await f.client.query('DROP ROLE '+quote(extra));await f.dispose();}
 },60000);
});
