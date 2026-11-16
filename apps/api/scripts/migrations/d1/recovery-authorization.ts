import type {Readable} from 'node:stream';

/** One bounded parent grant, received only after the prepared digest is durable.
 * EOF, a partial line, extra fields/lines, or a stalled parent cannot authorize
 * the database write. The input is never included in an error message. */
export async function awaitRecoveryAuthorization(input:Readable,snapshotSha256:string,timeoutMs=30_000){
 if(!/^[a-f0-9]{64}$/.test(snapshotSha256)||!Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>30_000)throw Error('INVALID_RECOVERY_AUTHORIZATION');
 await new Promise<void>((accept,reject)=>{
  let bytes=Buffer.alloc(0),finished=false;
  const cleanup=()=>{clearTimeout(timer);input.off('data',data);input.off('end',end);input.off('error',error);};
  const finish=(ok:boolean)=>{if(finished)return;finished=true;cleanup();if(ok)accept();else reject(Error('DURABLE_RECOVERY_AUTHORIZATION_REQUIRED'));};
  const data=(chunk:Buffer|string)=>{
   bytes=Buffer.concat([bytes,Buffer.isBuffer(chunk)?chunk:Buffer.from(chunk)]);
   if(bytes.length>1024){finish(false);return;}
   const newline=bytes.indexOf(10);if(newline<0)return;
   if(newline!==bytes.length-1){finish(false);return;}
   try{
    const grant:unknown=JSON.parse(bytes.subarray(0,newline).toString('utf8'));
    const valid=grant!==null&&typeof grant==='object'&&!Array.isArray(grant)&&Object.keys(grant).length===2&&
     (grant as {authorize?:unknown}).authorize===true&&(grant as {snapshotSha256?:unknown}).snapshotSha256===snapshotSha256;
    finish(valid);
   }catch{finish(false);}
  };
  const end=()=>finish(false),error=()=>finish(false);
  const timer=setTimeout(()=>finish(false),timeoutMs);
  input.on('data',data);input.once('end',end);input.once('error',error);
  if(input.readableEnded||input.destroyed)finish(false);
 });
}
