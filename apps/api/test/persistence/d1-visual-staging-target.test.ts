import {readFileSync} from 'node:fs';
import {describe,it,expect} from 'vitest';
import {validateVisualStagingTarget} from '../../scripts/migrations/d1/visual-staging-target';
import {validateStagingTarget} from '../../scripts/migrations/d1/staging-target';
const text=readFileSync(new URL('../../wrangler.d1-visual-staging.jsonc',import.meta.url),'utf8');
describe('visual rehearsal source and destination isolation',()=>{
 it('pins a production read source and a different private write destination',()=>{
  const target=validateVisualStagingTarget(text);expect(target.r2_buckets[0].binding).toBe('SOURCE_VIDEO_BUCKET');expect(target.r2_buckets[1].bucket_name).toBe('videoq-media-migration-staging-v3');
  expect(()=>validateStagingTarget(text)).toThrow();
 });
 it.each(['destination-production','source-other','swap','public-route','secret','database','extra-bucket'] as const)('rejects %s drift',kind=>{
  const target=structuredClone(validateVisualStagingTarget(text)) as unknown as {r2_buckets:{binding:string;bucket_name:string;remote:boolean}[];routes:string[];vars?:unknown;d1_databases:unknown[]};
  if(kind==='destination-production')target.r2_buckets[1].bucket_name='videoq-media-prod';
  if(kind==='source-other')target.r2_buckets[0].bucket_name='unapproved';
  if(kind==='swap')target.r2_buckets.reverse();
  if(kind==='public-route')target.routes=['example.test/*'];
  if(kind==='secret')target.vars={PRIVATE:'canary'};
  if(kind==='database')target.d1_databases=[{database_id:'production'}];
  if(kind==='extra-bucket')target.r2_buckets.push(target.r2_buckets[1]);
  expect(()=>validateVisualStagingTarget(JSON.stringify(target))).toThrow();
 });
});
