import ts from 'typescript';
import {z} from 'zod';
export const SYNTHETIC_STAGING_DATABASE_ID='8e84cb18-4712-48cf-b528-e880188b045f';
export class SyntheticStagingTargetError extends Error {readonly name='SyntheticStagingTargetError';}
const schema=z.object({
 $schema:z.string().optional(),name:z.literal('videoq-db-migration-staging-v2'),account_id:z.literal('12daec56fdba43f677f2766ee26a5a39'),
 main:z.literal('scripts/migrations/d1/staging-proxy.ts'),compatibility_date:z.string(),compatibility_flags:z.array(z.literal('nodejs_compat')),
 workers_dev:z.literal(false),preview_urls:z.literal(false),routes:z.array(z.never()).length(0),
 d1_databases:z.tuple([z.object({binding:z.literal('DB'),database_name:z.literal('videoq-d1-migration-staging-v2'),database_id:z.literal(SYNTHETIC_STAGING_DATABASE_ID),migrations_dir:z.literal('drizzle-d1'),remote:z.literal(true)}).strict()]),
 vectorize:z.array(z.object({binding:z.enum(['SCENE_VECTORIZE_1536','SCENE_VECTORIZE_768']),index_name:z.enum(['videoq-scenes-migration-v2-1536','videoq-scenes-migration-v2-768']),remote:z.literal(true)}).strict()).length(2),
}).strict();
/** Frozen synthetic v2 only. Real v3 data and arbitrary targets are refused. */
export function validateSyntheticStagingTarget(text:string){
 const parsed=ts.parseConfigFileTextToJson('wrangler.d1-staging.v2.jsonc',text),result=schema.safeParse(parsed.config as unknown);
 if(parsed.error||!result.success)throw new SyntheticStagingTargetError('Dedicated synthetic v2 staging target configuration is required.');
 const vectors=result.data.vectorize;
 if(!vectors.some(value=>value.binding==='SCENE_VECTORIZE_1536'&&value.index_name==='videoq-scenes-migration-v2-1536')||!vectors.some(value=>value.binding==='SCENE_VECTORIZE_768'&&value.index_name==='videoq-scenes-migration-v2-768'))throw new SyntheticStagingTargetError('Dedicated synthetic v2 staging vector bindings must match their model spaces.');
 return result.data;
}
