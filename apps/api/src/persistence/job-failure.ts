import { SafeJobError } from '../application/job-failure';
import type { JobRepository } from '../application/job-execution-port';
const networkCodes=new Set(['ECONNREFUSED','ECONNRESET','ENOTFOUND','ETIMEDOUT','EPIPE']);
/** Network codes become database facts only inside a database adapter. */
function databaseError(error:unknown):unknown {
  let current=error;
  try {
    for(let depth=0;depth<4 && current && typeof current==='object';depth++) {
      const facts=current as Record<string,unknown>;
      if(typeof facts.code==='string' && networkCodes.has(facts.code)) return new SafeJobError('DATABASE_UNAVAILABLE',true);
      current=facts.cause;
    }
  } catch { /* Preserve the original error; diagnostics handles unreadable facts. */ }
  return error;
}
export function safeJobRepository(repository:JobRepository):JobRepository {
  const invoke=async<T>(operation:()=>Promise<T>):Promise<T>=>{try{return await operation();}catch(error){throw databaseError(error);}};
  return {
    claim:input=>invoke(()=>repository.claim(input)),
    heartbeat:(id,token)=>invoke(()=>repository.heartbeat(id,token)),
    complete:(id,token)=>invoke(()=>repository.complete(id,token)),
    fail:(id,token,code)=>invoke(()=>repository.fail(id,token,code)),
  };
}
