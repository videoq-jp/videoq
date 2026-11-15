// Actual immutable operator ZIP and real isolated PostgreSQL; no AWS requests.
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp,writeFile,readFile,mkdir,symlink,realpath,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve,dirname} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {randomBytes,randomUUID,createHash} from 'node:crypto';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
const require=createRequire(join(root,'.github/operations-tools/package.json')),{Client}=require('pg');
const execute=promisify(execFile),directory=await realpath(await mkdtemp(join(tmpdir(),'videoq-fence-bundle-')));
const name='videoq-fence-audit-'+randomUUID().replaceAll('-',''),password=randomBytes(24).toString('hex'),database='recovery_'+randomUUID().replaceAll('-',''),prefix=database+'_';
const docker=(args)=>execute('docker',args,{cwd:root,timeout:120000,maxBuffer:1024*1024});
let client;
try{
 const envfile=join(directory,'private-postgres.env');await writeFile(envfile,'POSTGRES_PASSWORD='+password+'\nPOSTGRES_DB='+database+'\n',{mode:0o600});
 const image=(await readFile(join(root,'.github/operations-tools/Dockerfile'),'utf8')).trim().replace(/^FROM /,'');assert.match(image,/^pgvector\/pgvector:pg17@sha256:[a-f0-9]{64}$/);
 await docker(['run','--detach','--name',name,'--label','videoq-purpose=neon-fence-audit-fixture','--env-file',envfile,'-p','127.0.0.1::5432',image]);
 let ready=false;
 for(let i=0;i<60;i++){try{await docker(['exec',name,'pg_isready','-h','127.0.0.1','-U','postgres','-d',database]);ready=true;break;}catch{await new Promise(r=>setTimeout(r,500));}}assert.ok(ready,'dedicated PostgreSQL did not become ready');
 const info=JSON.parse((await docker(['inspect',name])).stdout)[0];assert.equal(info.Config.Labels['videoq-purpose'],'neon-fence-audit-fixture');
 const port=info.NetworkSettings.Ports['5432/tcp'][0].HostPort,url=new URL('postgresql://postgres@127.0.0.1:'+port+'/'+database);url.password=password;
 client=new Client({connectionString:url.toString()});client.on('error',()=>{});await client.connect();
 const api=prefix+'api',backup=prefix+'backup_1',quote=s=>'"'+s.replaceAll('"','""')+'"';
 await client.query('CREATE TABLE public.fence_probe(value integer); CREATE ROLE '+quote(api)+' LOGIN; CREATE ROLE '+quote(backup)+' LOGIN; GRANT USAGE ON SCHEMA public TO '+quote(api)+','+quote(backup)+'; GRANT SELECT,INSERT ON public.fence_probe TO '+quote(api)+'; GRANT SELECT ON public.fence_probe TO '+quote(backup));
 const before=(await client.query('SELECT oid::int,rolname,rolcanlogin FROM pg_roles WHERE left(rolname,length($1))=$1 ORDER BY rolname',[prefix])).rows;
 const bundle=join(directory,'bundle');await mkdir(bundle,{mode:0o700});
 await execute('python3',['-c',"import importlib.util,sys,zipfile; from pathlib import Path; spec=importlib.util.spec_from_file_location('bundle','infra/db-maintenance/build_bundle.py'); b=importlib.util.module_from_spec(spec); spec.loader.exec_module(b); p=Path(sys.argv[1])/'operator.zip'; b.archive(p,b.operator_files()); zipfile.ZipFile(p).extractall(sys.argv[1])",bundle],{cwd:root,timeout:30000,maxBuffer:1024*1024});
 const ops=join(root,'.github/operations-tools/node_modules');await symlink(ops,join(bundle,'.github/operations-tools/node_modules'),'dir');
 const {ensureOperatorDependencies}=await import(pathToFileURL(join(bundle,'.github/scripts/neon-fence-audit.mjs')).href);await ensureOperatorDependencies(bundle);
 const output=join(directory,'plan.json'),target=join(directory,'target.json');await writeFile(target,JSON.stringify({purpose:'isolated-rehearsal',host:'127.0.0.1',databaseName:database,rolePrefix:prefix}),{mode:0o600});
 const env=Object.fromEntries(['PATH','HOME','TMPDIR','LANG'].filter(k=>process.env[k]).map(k=>[k,process.env[k]]));env.VIDEOQ_FENCE_ADMIN_DATABASE_URL=url.toString();env.PGOPTIONS='-c default_transaction_read_only=on -c search_path=pg_catalog';
 const loader=pathToFileURL(join(ops,'tsx/dist/loader.mjs')).href,args=['--import',loader,join(bundle,'apps/api/scripts/d1-postgres-login-fence.ts'),'--mode','prepare','--target',target,'--state',output];
 const run=()=>execute(process.execPath,args,{cwd:bundle,env,timeout:30000,maxBuffer:65536});
 const {stdout}=await run(),proof=JSON.parse(stdout.trim()),plan=JSON.parse(await readFile(output,'utf8'));
 assert.equal(proof.prepared,true);assert.equal(proof.writeFenceInstalled,false);assert.equal(proof.roles,2);assert.equal(plan.target.databaseName,database);assert.equal(plan.roles.length,2);assert.match(plan.catalogSha256,/^[a-f0-9]{64}$/);
 assert.equal(JSON.stringify(plan).includes(password),false);assert.equal(stdout.includes(password),false);
 assert.deepEqual((await client.query('SELECT oid::int,rolname,rolcanlogin FROM pg_roles WHERE left(rolname,length($1))=$1 ORDER BY rolname',[prefix])).rows,before);
 const digest=createHash('sha256').update(await readFile(output)).digest('hex');await assert.rejects(run());assert.equal(createHash('sha256').update(await readFile(output)).digest('hex'),digest);
 const readOnlyCode="const {Client}=require('pg');(async()=>{const c=new Client({connectionString:process.env.VIDEOQ_FENCE_ADMIN_DATABASE_URL});try{await c.connect();try{await c.query('INSERT INTO public.fence_probe VALUES(1)');throw Error('WRITE_WAS_ALLOWED');}catch(e){if(e.code!=='25006')throw e;console.log('READ_ONLY_VERIFIED');}}finally{await c.end();}})().catch(()=>{process.exitCode=1});";
 assert.equal((await execute(process.execPath,['-e',readOnlyCode],{cwd:bundle,env,timeout:30000,maxBuffer:65536})).stdout.trim(),'READ_ONLY_VERIFIED');
 assert.equal((await client.query('SELECT count(*)::int n FROM public.fence_probe')).rows[0].n,0);
 console.log(JSON.stringify({actualOperatorZip:true,realLoopbackPostgres:true,planPrepared:true,rolesUnchanged:true,readOnlyEnforced:true,existingPlanNotOverwritten:true,awsAccess:false,productionAccess:false}));
}finally{
 await client?.end().catch(()=>{});
 try{const info=JSON.parse((await docker(['inspect',name])).stdout)[0];assert.equal(info.Config.Labels['videoq-purpose'],'neon-fence-audit-fixture');await docker(['rm','--force','--volumes',name]);}catch(error){if(!String(error.stderr||'').includes('No such object'))throw error;}
 await rm(directory,{recursive:true,force:true});
}
