import {handleEdgeBenchmark} from './edge-benchmark-http';
import {measureEdgeDatabases,type BenchmarkBindings} from './edge-benchmark-worker';
type Env=BenchmarkBindings&{BENCHMARK_TOKEN?:string};
export default {
 fetch(request:Request,env:Env){return handleEdgeBenchmark(request,env.BENCHMARK_TOKEN,input=>measureEdgeDatabases(env,input));},
};
