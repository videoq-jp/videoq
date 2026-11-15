import {readFileSync} from 'node:fs';
import {describe,it,expect} from 'vitest';
import {validateEdgeBenchmarkTarget} from '../../scripts/migrations/d1/edge-benchmark-target';
const text=readFileSync(new URL('../../wrangler.d1-edge-benchmark.jsonc',import.meta.url),'utf8');
describe('private edge measurement deployment boundary',()=>{
 it('accepts the fixed staging target',()=>{
  expect(validateEdgeBenchmarkTarget(text).workers_dev).toBe(false);
 });
 it.each(['routes','workers_dev','preview_urls','vars','hyperdrive','d1_databases','main','name','account_id','services','limits'])('rejects %s drift',key=>{
  const config:Record<string,unknown>={...validateEdgeBenchmarkTarget(text)};
  config[key]=key==='routes'?['example.test/*']:key==='workers_dev'||key==='preview_urls'?true:{};
  expect(()=>validateEdgeBenchmarkTarget(JSON.stringify(config))).toThrow('PINNED_PRIVATE_EDGE_BENCHMARK_REQUIRED');
 });
});
