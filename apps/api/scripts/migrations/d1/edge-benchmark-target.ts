import ts from 'typescript';
import {z} from 'zod';
const schema=z.object({
 $schema:z.string().optional(),name:z.literal('videoq-db-migration-benchmark-v3'),
 account_id:z.literal('12daec56fdba43f677f2766ee26a5a39'),
 main:z.literal('scripts/migrations/d1/edge-benchmark-worker.ts'),
 compatibility_date:z.literal('2026-11-14'),compatibility_flags:z.tuple([z.literal('nodejs_compat')]),
 workers_dev:z.literal(false),preview_urls:z.literal(false),routes:z.array(z.never()).length(0),
 d1_databases:z.tuple([z.object({binding:z.literal('DB'),database_name:z.literal('videoq-d1-migration-staging-v3'),database_id:z.literal('373d6ca5-2796-460d-8ab1-e644de46bb3c')}).strict()]),
 hyperdrive:z.tuple([z.object({binding:z.literal('HYPERDRIVE'),id:z.literal('d69ecb01a493415197e52552db2990f8')}).strict()]),
}).strict();
/** Dedicated private Worker, staging D1, and the existing managed source binding.
 * No arbitrary SQL, credentials, public route, or application deployment. */
export function validateEdgeBenchmarkTarget(text:string){
 const parsed=ts.parseConfigFileTextToJson('wrangler.d1-edge-benchmark.jsonc',text);
 const result=schema.safeParse(parsed.config as unknown);
 if(parsed.error||!result.success)throw new Error('PINNED_PRIVATE_EDGE_BENCHMARK_REQUIRED');
 return result.data;
}
