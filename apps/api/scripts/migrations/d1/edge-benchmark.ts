import {z} from 'zod';
export const edgeBenchmarkInput=z.object({version:z.literal(1),cases:z.array(z.object({videoId:z.number().int().positive().safe(),userId:z.string().min(1).max(256)}).strict()).min(1).max(25),samples:z.number().int().min(1).max(25)}).strict().refine(input=>input.cases.length*input.samples<=25);
export type EdgeBenchmarkInput=z.infer<typeof edgeBenchmarkInput>;
export type EdgeRead=(request:EdgeBenchmarkInput['cases'][number])=>Promise<boolean>;
/** Same read and input in one Worker invocation. No rows or scope identifiers
 * leave the Worker. This does not measure full APIs or force Neon cold starts. */
export async function measureEdgeReads(readers:{postgres:EdgeRead;d1:EdgeRead},raw:unknown,now=()=>performance.now()){
 const parsed=edgeBenchmarkInput.safeParse(raw);if(!parsed.success)throw new Error('INVALID_EDGE_BENCHMARK_INPUT');
 const input=parsed.data,durations={postgres:[] as number[],d1:[] as number[]};let pairs=0;
 for(const request of input.cases)for(let sample=0;sample<input.samples;sample++){
  const found={postgres:false,d1:false},order=pairs%2?['d1','postgres'] as const:['postgres','d1'] as const;
  for(const backend of order){const start=now();found[backend]=await readers[backend]({...request});const elapsed=now()-start;if(!Number.isFinite(elapsed)||elapsed<0)throw new Error('INVALID_BENCHMARK_CLOCK');durations[backend].push(elapsed);}
  if(found.postgres!==found.d1||!found.postgres)throw new Error('BENCHMARK_OWNED_ROW_DOES_NOT_MATCH');pairs++;
 }
 return {version:1,workload:'owned-video-identifier-lookup',execution:'both backends inside the same Worker invocation',paired_reads:pairs,durations_ms:durations,all_owned_rows_found:true,cold_start_controlled:false,api_e2e_measured:false,acceptance_criteria_applied:false,execution_complete:false};
}
