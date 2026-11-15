import {readFileSync} from 'node:fs';
import {describe,it,expect} from 'vitest';
import {validateSyntheticStagingTarget,SYNTHETIC_STAGING_DATABASE_ID} from '../../scripts/migrations/d1/synthetic-staging-target';
import {validateStagingTarget} from '../../scripts/migrations/d1/staging-target';
const read=(name:string)=>readFileSync(new URL(`../../${name}`,import.meta.url),'utf8');
const text=read('wrangler.d1-staging.v2.jsonc');
describe('frozen synthetic v2 target',()=>{
 it('accepts only v2 and remains disjoint from the real-data validator',()=>{
  expect(validateSyntheticStagingTarget(text).d1_databases[0].database_id).toBe(SYNTHETIC_STAGING_DATABASE_ID);
  expect(()=>validateStagingTarget(text)).toThrow();
 });
 it.each(['wrangler.d1-staging.jsonc','wrangler.d1-staging.v1.jsonc','wrangler.jsonc','wrangler.d1-visual-staging.jsonc'])('rejects %s',name=>{
  expect(()=>validateSyntheticStagingTarget(read(name))).toThrow();
 });
 it.each(['database','index','public','secret','hyperdrive','worker','account'])('rejects %s drift',kind=>{
  const config:Record<string,unknown>={...validateSyntheticStagingTarget(text)};
  if(kind==='database')config.d1_databases=[{binding:'DB',database_id:'373d6ca5-2796-460d-8ab1-e644de46bb3c'}];
  if(kind==='index')config.vectorize=[{binding:'SCENE_VECTORIZE_768',index_name:'videoq-scenes-migration-v3-768',remote:true}];
  if(kind==='public')config.workers_dev=true;
  if(kind==='secret')config.vars={SECRET:'canary'};
  if(kind==='hyperdrive')config.hyperdrive=[{}];
  if(kind==='worker')config.name='videoq-db-migration-staging-v3';
  if(kind==='account')config.account_id='other';
  expect(()=>validateSyntheticStagingTarget(JSON.stringify(config))).toThrow();
 });
});
