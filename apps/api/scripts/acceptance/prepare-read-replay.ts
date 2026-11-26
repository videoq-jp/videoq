/** Offline replay catalog derived through actual auth/search adapters. Keeps SQL/parameters private. */
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import {createHash} from 'node:crypto';
import {createD1Auth} from '../../src/persistence/d1/auth';
import {createD1SceneSearchRepository} from '../../src/persistence/d1/scene-search';
import {embeddingFingerprint,resolveEmbeddingConfig} from '../../src/lib/embedding-contract';
import {replayDatabase} from './d1-read-replay';
import type {Bindings} from '../../src/types/bindings';
import type {Vectorize} from '@cloudflare/workers-types';
type Sample={trace:{sql:Record<string,{calls:number}>}};
type Cell={tenantVideoCount:number;coldLogical:Sample;samples:Sample[]};
type Measurement={identity:unknown;result:{cells:Cell[]}};
const directory=process.env.ACCEPTANCE_PRIVATE_DIR;assert(directory);
const hash=(data:string)=>createHash('sha256').update(data).digest('hex');
const snapshot=readFileSync(directory+'/snapshot.sql','utf8'),state=JSON.parse(readFileSync(directory+'/private.json','utf8')) as {authSecret:string;cookie:string};
const source=new DatabaseSync(':memory:');source.exec(snapshot);
const receipt=JSON.parse(readFileSync(directory+'/receipt.json','utf8')) as {operations:({command:string}&Measurement)[]};
const measurement=receipt.operations.findLast((row:{command:string})=>row.command==='measure');assert(measurement);
const profiles=[];
for(const size of [1,100,1000]){
 const calls:{sql:string;params:unknown[];sqlSha256:string}[]=[];
 const database=replayDatabase(async(sql,params)=>{
  await Promise.resolve();
  assert(/^select\b/i.test(sql.trim()),'Catalog must be read-only');
  const statement=source.prepare(sql);statement.setReturnArrays(true);
  const values=statement.all(...params as (string|number|null)[]) as unknown as unknown[][];
  calls.push({sql,params,sqlSha256:hash(sql)});
  return {success:true,meta:{rows_read:0,rows_written:0},results:{columns:statement.columns().map(column=>column.name),rows:values}};
 },()=>{});
 const env={ENVIRONMENT:'production',DEPLOYMENT_EDITION:'cloud',PERSISTENCE_BACKEND:'d1',DB:database,BETTER_AUTH_URL:'https://videoq-acceptance-20261125-c33d.yukiharada1228.workers.dev',FRONTEND_URL:'https://videoq-acceptance-20261125-c33d.yukiharada1228.workers.dev',BETTER_AUTH_SECRET:state.authSecret,EMBEDDING_PROVIDER:'workers-ai',EMBEDDING_PROFILE:'embeddinggemma2'} as Bindings;
 const auth=createD1Auth(env,database,'browser');
 for(let i=0;i<1;i++){const session=await auth.api.getSession({headers:new Headers({cookie:state.cookie}),query:{disableCookieCache:true,disableRefresh:true}});assert.equal(session?.user.id,'owner');}
 const rows=source.prepare('SELECT s.id,s.revision,s.vector_id,s.video_id,v.user_id FROM scenes s JOIN videos v ON v.id=s.video_id WHERE s.dimensions=768').all() as {id:string;revision:string;vector_id:string;video_id:number;user_id:string}[];
 const index={query:(_vector:unknown,options:{filter:{video_id?:{$in:number[]}}})=>Promise.resolve({matches:rows.filter(row=>!options.filter.video_id||options.filter.video_id.$in.includes(row.video_id)).map(row=>({id:row.vector_id,score:.99,metadata:{scene_id:row.id,revision:row.revision,vector_id:row.vector_id,video_id:row.video_id,user_id:row.user_id}})),count:rows.length})} as unknown as Vectorize;
 const repo=createD1SceneSearchRepository(database,index,768,await embeddingFingerprint(resolveEmbeddingConfig(env)));
 const found=await repo.search({queryEmbedding:Array.from({length:768},(_,i)=>i===0?1:0),userId:'owner',videoIds:Array.from({length:size},(_,i)=>i+1),limit:10});assert.equal(found.length,size===1?1:2);
 const actual:Record<string,number>={};for(const call of calls)actual[call.sqlSha256]=(actual[call.sqlSha256]??0)+1;
 const original:Cell|undefined=measurement.result.cells.find((cell:{tenantVideoCount:number})=>cell.tenantVideoCount===size);
 assert(original);
 const expected:Record<string,number>=Object.fromEntries(Object.entries(original.coldLogical.trace.sql).map(([key,value])=>[key,value.calls]));
 assert.deepEqual(actual,expected,'Actual auth/search SQL profile must match frozen request');
 for(const cell of measurement.result.cells.filter((cell:{tenantVideoCount:number})=>cell.tenantVideoCount===size))for(const sample of [cell.coldLogical,...cell.samples])assert.deepEqual(actual,Object.fromEntries(Object.entries(sample.trace.sql).map(([key,value])=>[key,value.calls])));
 profiles.push({size,calls,originalSqlCalls:actual});
}
const schema=source.prepare("SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE sql IS NOT NULL ORDER BY type,name").all();
const data={videos:source.prepare('SELECT count(*) AS n FROM videos').get()?.n,scenes:source.prepare('SELECT count(*) AS n FROM scenes').get()?.n,indexes:source.prepare("SELECT count(*) AS n FROM sqlite_schema WHERE type='index'").get()?.n};
writeFileSync(directory+'/read-replay-catalog-private.json',JSON.stringify({originalMeasurementIdentity:measurement.identity,snapshotSha256:hash(snapshot),schemaSha256:hash(JSON.stringify(schema)),schema,data,profiles}),{mode:0o600});
console.log(JSON.stringify({prepared:true,profiles:profiles.map(row=>({size:row.size,calls:row.calls.length})),data,allSqlProfilesMatch:true,metadataMeasurement:false}));
source.close();
