// Private, bounded pipe protocol. A prepared digest is never a database grant
// until the parent has durably bound it to the owned recovery intent.
const {spawn}=require('node:child_process');
function runRecoveryChild({command,args,cwd,env,onPrepared,timeoutMs=1800000,spawnChild=spawn}){
 return new Promise((resolve,reject)=>{
  const child=spawnChild(command,args,{cwd,env,stdio:['pipe','pipe','pipe']}),chunks=[];
  let buffered='',size=0,errors=0,prepared,committed=false,failed=false,closed=false,settled=false,chain=Promise.resolve();
  const timer=setTimeout(()=>stop(),timeoutMs);let killTimer;
  function fail(){if(settled)return;settled=true;clearTimeout(timer);clearTimeout(killTimer);reject(Error('RECOVERY_CHILD_FAILED_KEEP_WRITERS_STOPPED'));}
  function stop(){if(failed)return;failed=true;child.stdin.destroy();if(closed){fail();return;}child.kill('SIGTERM');killTimer=setTimeout(()=>child.kill('SIGKILL'),5000);killTimer.unref();}
  child.stdout.on('data',chunk=>{
   size+=chunk.length;if(size>16384){stop();return;}buffered+=chunk.toString('utf8');
   let newline;while((newline=buffered.indexOf('\n'))>=0){const line=buffered.slice(0,newline);buffered=buffered.slice(newline+1);
    chain=chain.then(async()=>{
     if(failed)throw Error('RECOVERY_CHILD_FAILED');const message=JSON.parse(line);
     if(!prepared&&message?.event==='recovery_prepared'&&Object.keys(message).sort().join(',')==='event,inputSha256,manifestSha256,snapshotSha256'&&/^[a-f0-9]{64}$/.test(message.snapshotSha256)){
      await onPrepared(message);if(failed)throw Error('RECOVERY_CHILD_FAILED');prepared=message;
      child.stdin.write(JSON.stringify({authorize:true,snapshotSha256:message.snapshotSha256})+'\n');child.stdin.end();return;
     }
     if(prepared&&!committed&&message?.event==='recovery_committed'&&Object.keys(message).sort().join(',')==='event,postgresLoginFenceVerified,snapshotSha256'&&message.snapshotSha256===prepared.snapshotSha256&&message.postgresLoginFenceVerified===true){committed=true;chunks.push(message);return;}
     throw Error('RECOVERY_CHILD_PROTOCOL_FAILED');
    }).catch(()=>{stop();});
   }
  });
  child.stderr.on('data',chunk=>{errors+=chunk.length;if(errors>65536)stop();});
  child.stdin.on('error',()=>stop());child.on('error',()=>stop());
  child.on('close',(code,signal)=>{
   closed=true;if(failed){fail();return;}
   chain.then(()=>{
    clearTimeout(timer);clearTimeout(killTimer);
    if(failed||code!==0||signal||buffered!==''||!prepared||!committed){fail();return;}
    if(!settled){settled=true;resolve({prepared,committed:chunks[0]});}
   },fail);
  });
 });
}
module.exports={runRecoveryChild};
