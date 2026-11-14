import ts from 'typescript';
import {z} from 'zod';
import {validateStagingTarget,StagingTargetError} from './staging-target';
const buckets=z.tuple([
 z.object({binding:z.literal('SOURCE_VIDEO_BUCKET'),bucket_name:z.literal('videoq-media-prod'),remote:z.literal(true)}).strict(),
 z.object({binding:z.literal('VIDEO_BUCKET'),bucket_name:z.literal('videoq-media-migration-staging-v3'),remote:z.literal(true)}).strict(),
]);
/** The production bucket is a read source; all create operations use the separate
 * private rehearsal destination. There are no application routes or secrets. */
export function validateVisualStagingTarget(text:string){
 const parsed=ts.parseConfigFileTextToJson('wrangler.d1-visual-staging.jsonc',text);
 const config=z.object({r2_buckets:buckets}).passthrough().safeParse(parsed.config as unknown);
 if(parsed.error||!config.success)throw new StagingTargetError('Dedicated visual source and private destination are required.');
 const {r2_buckets,...target}=config.data;return {...validateStagingTarget(JSON.stringify(target)),r2_buckets};
}
