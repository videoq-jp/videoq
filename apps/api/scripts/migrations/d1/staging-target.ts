import ts from 'typescript';
import {z} from 'zod';
export class StagingTargetError extends Error {readonly name='StagingTargetError';}
const schema=z.object({
 $schema:z.string().optional(),name:z.literal('videoq-db-migration-staging'),account_id:z.literal('12daec56fdba43f677f2766ee26a5a39'),
 main:z.literal('scripts/migrations/d1/staging-proxy.ts'),compatibility_date:z.string(),compatibility_flags:z.array(z.literal('nodejs_compat')),
 workers_dev:z.literal(false),preview_urls:z.literal(false),routes:z.array(z.never()).length(0),
 d1_databases:z.tuple([z.object({binding:z.literal('DB'),database_name:z.literal('videoq-d1-migration-staging'),database_id:z.literal('538bebc4-9485-4e91-8799-c236eeed1dd2'),migrations_dir:z.literal('drizzle-d1'),remote:z.literal(true)}).strict()]),
 vectorize:z.array(z.object({binding:z.enum(['SCENE_VECTORIZE_1536','SCENE_VECTORIZE_768']),index_name:z.enum(['videoq-scenes-migration-1536','videoq-scenes-migration-768']),remote:z.literal(true)}).strict()).length(2),
}).strict();
/** No arbitrary account, DB, production binding, secret or public endpoint. */
export function validateStagingTarget(text:string){
 const parsed=ts.parseConfigFileTextToJson('wrangler.d1-staging.jsonc',text),result=schema.safeParse(parsed.config as unknown);
 if(parsed.error||!result.success)throw new StagingTargetError('Dedicated staging target configuration is required.');
 const vectors=result.data.vectorize;
 if(!vectors.some(value=>value.binding==='SCENE_VECTORIZE_1536'&&value.index_name==='videoq-scenes-migration-1536')||!vectors.some(value=>value.binding==='SCENE_VECTORIZE_768'&&value.index_name==='videoq-scenes-migration-768'))throw new StagingTargetError('Dedicated staging vector bindings must match their model spaces.');
 return result.data;
}
