import {expect,it} from 'vitest';
import {inspectCloudCutoverConfig} from '../../scripts/migrations/d1/cutover-config';
const target=()=>({name:'videoq-api-staging',workers_dev:false,vars:{ENVIRONMENT:'production',DEPLOYMENT_EDITION:'cloud'},d1_databases:[{binding:'DB',database_id:'12345678-1234-1234-1234-123456789abc',database_name:'videoq-staging',migrations_dir:'drizzle-d1'}],vectorize:[{binding:'SCENE_VECTORIZE_1536',index_name:'scene-1536'},{binding:'SCENE_VECTORIZE_768',index_name:'scene-768'}]});
const check=(scope:unknown)=>inspectCloudCutoverConfig(JSON.stringify({env:{staging:scope}}),'staging');
it('validates JSONC environment bindings while retaining explicit remote verification limits',()=>{
 const text='// Local proposal only\n'+JSON.stringify({env:{staging:target()}}).replace(/}$/,',}');
 const result=inspectCloudCutoverConfig(text,'staging');expect(result.configuration_valid).toBe(true);expect(result.warnings.join(' ')).toContain('does not verify remote');
});
it('rejects inherited root bindings and unknown environments',()=>{
 expect(inspectCloudCutoverConfig(JSON.stringify({...target(),env:{staging:{name:'staging',workers_dev:false,vars:{ENVIRONMENT:'production',DEPLOYMENT_EDITION:'cloud'}}}}),'staging').configuration_valid).toBe(false);
 expect(inspectCloudCutoverConfig(JSON.stringify({env:{staging:target()}}),'production').configuration_valid).toBe(false);
});
it.each(['rollback','postgres','onprem','development','zero-id','wrong-history','partial-history','same-index','missing-index','public-url','plaintext-secret'] as const)('rejects %s cutover configuration',kind=>{
 const scope=target() as ReturnType<typeof target>&{vars:Record<string,string>;d1_databases:Array<Record<string,unknown>>};
 if(kind==='rollback')scope.vars.MIGRATION_ALLOW_CLOUD_POSTGRES='true';if(kind==='postgres')scope.vars.PERSISTENCE_BACKEND='postgres';if(kind==='onprem')scope.vars.DEPLOYMENT_EDITION='onprem';if(kind==='development')scope.vars.ENVIRONMENT='development';if(kind==='zero-id')scope.d1_databases[0].database_id='00000000-0000-0000-0000-000000000000';if(kind==='wrong-history')scope.d1_databases[0].migrations_dir='drizzle';if(kind==='partial-history')Object.assign(scope.d1_databases[0],{migrations_pattern:'drizzle-d1/0016*.sql'});if(kind==='same-index')scope.vectorize[1].index_name=scope.vectorize[0].index_name;if(kind==='missing-index')scope.vectorize.pop();if(kind==='public-url')scope.workers_dev=true;if(kind==='plaintext-secret')scope.vars.WORKER_INTERNAL_API_SECRET='private-canary-value';
 const result=check(scope);expect(result.configuration_valid).toBe(false);expect(JSON.stringify(result)).not.toContain('private-canary-value');
});
it('reports syntax errors without echoing configuration contents',()=>{
 expect(inspectCloudCutoverConfig('{private-canary-value','production')).toEqual({configuration_valid:false,errors:['Invalid Wrangler JSONC.'],warnings:[]});
});
