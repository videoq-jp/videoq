import {lstat,open} from 'node:fs/promises';
import {dirname,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import pg from 'pg';
import {readPrivateInput} from './migrations/d1/private-input';
import {postgresLoginFencePlanSchema,postgresLoginFenceTargetSchema,preparePostgresLoginFence,inspectPostgresLoginFence,installPostgresLoginFence,releasePostgresLoginFence} from './migrations/d1/postgres-login-fence';
function fail(message:string):never{throw new Error(message);}
export async function main(args=process.argv.slice(2)){
 const options=new Map<string,string>();
 for(let i=0;i<args.length;i+=2){if(!['--mode','--target','--state','--confirm-database'].includes(args[i])||options.has(args[i])||!args[i+1]||args[i+1].startsWith('--'))fail('Invalid PostgreSQL fence arguments.');options.set(args[i],args[i+1]);}
 const mode=options.get('--mode'),prepare=mode==='prepare',mutate=mode==='install'||mode==='release';
 if(!['prepare','inspect','install','release'].includes(mode??'')||!options.has('--state')||options.size!==(prepare||mutate?3:2)||prepare&&!options.has('--target')||mutate&&!options.has('--confirm-database'))fail('Invalid PostgreSQL fence options.');
 const statePath=resolve(options.get('--state')!),parent=await lstat(dirname(statePath));
 if(!parent.isDirectory()||parent.isSymbolicLink()||(parent.mode&0o077)||parent.uid!==process.getuid?.())fail('Private operator-owned state directory required.');
 const plan=prepare?undefined:postgresLoginFencePlanSchema.parse(JSON.parse((await readPrivateInput(statePath,1024**2)).toString()));
 const target=prepare?postgresLoginFenceTargetSchema.parse(JSON.parse((await readPrivateInput(resolve(options.get('--target')!),65536)).toString())):plan!.target;
 if(mutate&&(options.get('--confirm-database')!==target.databaseName||process.env.VIDEOQ_MIGRATION_UPSTREAM_STOPPED!=='1'))fail('Exact target database confirmation and stopped upstream required.');
 const value=process.env.VIDEOQ_FENCE_ADMIN_DATABASE_URL;if(!value||Array.from(value).some(character=>character.charCodeAt(0)<32||character.charCodeAt(0)===127))fail('Private administration connection required.');
 const url=new URL(value);
 if(!['postgres:','postgresql:'].includes(url.protocol)||!url.username||!url.password||url.hostname.replace(/^\[|\]$/g,'')!==target.host||decodeURIComponent(url.pathname.slice(1))!==target.databaseName||url.hash||url.searchParams.has('options')||target.purpose==='production'&&url.searchParams.get('sslmode')!=='verify-full')fail('Administration URL differs from the fixed fence target.');
 const output=prepare?await open(statePath,'wx',0o600):undefined;
 const client=new pg.Client({connectionString:value,application_name:'videoq-migration-login-fence',connectionTimeoutMillis:10000,statement_timeout:30000,query_timeout:30000});client.on('error',()=>{});
 try{
  await client.connect();
  if(prepare){const prepared=await preparePostgresLoginFence(client,target);await output!.writeFile(JSON.stringify(prepared)+'\n');await output!.sync();console.info(JSON.stringify({prepared:true,purpose:target.purpose,roles:prepared.roles.length,writeFenceInstalled:false}));}
  else{
   const result=mode==='install'?await installPostgresLoginFence(client,plan!,true):mode==='release'?await releasePostgresLoginFence(client,plan!,true):await inspectPostgresLoginFence(client,plan!);
   console.info(JSON.stringify({...result,purpose:target.purpose,upstreamStoppedByThisCommand:false}));
  }
 }finally{await output?.close();await client.end().catch(()=>{});}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){try{await main();}catch{console.error('PostgreSQL managed-login fence failed. Preserve the private plan and keep upstream stopped. No automatic LOGIN restoration was attempted.');process.exitCode=1;}}
