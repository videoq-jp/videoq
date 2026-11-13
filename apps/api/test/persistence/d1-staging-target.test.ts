import {readFileSync} from 'node:fs';
import {describe,it,expect} from 'vitest';
import {validateStagingTarget} from '../../scripts/migrations/d1/staging-target';
import {parseStagingMigrationArguments,stagingMigrationExitCode} from '../../scripts/migrations/d1/staging-migration';
const text=readFileSync(new URL('../../wrangler.d1-staging.jsonc',import.meta.url),'utf8');
describe('dedicated remote staging target isolation',()=>{
 it('accepts the actual nonpublic dedicated resource config',()=>{expect(validateStagingTarget(text).d1_databases[0].database_name).toBe('videoq-d1-migration-staging');});
 it('rejects the existing production config',()=>{expect(()=>validateStagingTarget(readFileSync(new URL('../../wrangler.jsonc',import.meta.url),'utf8'))).toThrow();});
 it.each(['account','database','public-route','workers-dev','preview','index-profile','duplicate-index','main','secret','r2','hyperdrive'] as const)('rejects %s config drift',kind=>{
  const config=structuredClone(validateStagingTarget(text)) as unknown as Record<string,unknown>;
  if(kind==='account')config.account_id='other';if(kind==='database')config.d1_databases=[{binding:'DB',database_id:'other'}];if(kind==='public-route')config.routes=['example.test/*'];if(kind==='workers-dev')config.workers_dev=true;if(kind==='preview')config.preview_urls=true;if(kind==='main')config.main='src/index.ts';if(kind==='secret')config.vars={BETTER_AUTH_SECRET:'private-canary'};if(kind==='r2')config.r2_buckets=[{bucket_name:'production'}];if(kind==='hyperdrive')config.hyperdrive=[{}];
  if(kind==='index-profile'||kind==='duplicate-index')config.vectorize=[{binding:'SCENE_VECTORIZE_1536',index_name:kind==='index-profile'?'videoq-scenes-migration-768':'videoq-scenes-migration-1536',remote:true},{binding:'SCENE_VECTORIZE_768',index_name:'videoq-scenes-migration-1536',remote:true}];
  let error:unknown;try{validateStagingTarget(JSON.stringify(config));}catch(value){error=value;}expect(error).toBeInstanceOf(Error);expect(String(error)).not.toContain('private-canary');
 });
});
describe('staging migration phase arguments',()=>{
 it('selects import without implicitly permitting incomplete visuals',()=>{expect(parseStagingMigrationArguments(['--mode','import','--input','/private/source'])).toMatchObject({mode:'import',allowPendingVisuals:false});});
 it('requires explicit phase-specific options',()=>{expect(parseStagingMigrationArguments(['--input','/private/source','--mode','deliver','--max-tasks','101'])).toMatchObject({mode:'deliver',maxTasks:101});expect(parseStagingMigrationArguments(['--mode','import','--input','/private/source','--allow-pending-visuals']).allowPendingVisuals).toBe(true);});
 it.each([[],['--mode','deploy','--input','x'],['--mode','import'],['--mode','verify','--input','x','--max-tasks','1'],['--mode','deliver','--input','x','--max-tasks','0'],['--mode','deliver','--input','x','--max-tasks','10001'],['--mode','deliver','--input','x','--max-tasks','1e2'],['--mode','verify','--input','x','--allow-pending-visuals'],['--mode','import','--input','x','--input','y'],['--mode','import','--input','x','--config','production'],['--mode','import','--input','x','--allow-pending-visuals','--allow-pending-visuals']])('rejects invalid phase arguments %j',args=>{expect(()=>parseStagingMigrationArguments(args)).toThrow();});
});

describe('staging migration exit gates',()=>{
 it('does not treat pending/mismatched vector verification as a successful gate',()=>{expect(stagingMigrationExitCode({phase:'verify',vectorize_delivery_complete:false})).toBe(2);expect(stagingMigrationExitCode({phase:'verify',vectorize_delivery_complete:true})).toBe(0);});
 it('reports delivery failure or lease loss as retryable',()=>{expect(stagingMigrationExitCode({phase:'deliver',failed:1,leaseLost:0})).toBe(2);expect(stagingMigrationExitCode({phase:'deliver',failed:0,leaseLost:1})).toBe(2);expect(stagingMigrationExitCode({phase:'deliver',failed:0,leaseLost:0})).toBe(0);});
});
