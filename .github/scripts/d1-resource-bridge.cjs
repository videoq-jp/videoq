// One-shot private pipes only. Credential/input data never enters argv or logs.
const {spawn}=require('node:child_process');
const path=require('node:path');
const ACTIONS=new Set(['ownership-check','prepare-fence','inspect-source-fence','inspect-target-fence','install-source-fence','remove-target-fence']);
const LIMIT=1024*1024;
function createResourceBridge({assertExecutor,assertOperation,assertTargetSafe,python='python3',enabled=false}){
 if([assertExecutor,assertOperation,assertTargetSafe].some(value=>typeof value!=='function')||typeof python!=='string'||!python||python.includes('\0'))throw Error('RESOURCE_BRIDGE_CONTEXT_REQUIRED');
 return{
  async call(action,input,token){
   if(!enabled)throw Error('RESOURCE_BRIDGE_DISABLED');
   if(!ACTIONS.has(action)||!input||typeof input!=='object'||Array.isArray(input))throw Error('RESOURCE_BRIDGE_ACTION_REQUIRED');
   try{await assertExecutor();await assertOperation(action,input);}catch{throw Error('RESOURCE_BRIDGE_OWNERSHIP_REQUIRED');}
   const initial=JSON.stringify({version:1,enabled:true,action,input,token:token??null})+'\n';
   if(Buffer.byteLength(initial)>LIMIT)throw Error('RESOURCE_BRIDGE_INPUT_LIMIT');
   return new Promise((resolve,reject)=>{
    const child=spawn(python,[path.resolve(__dirname,'../../infra/scripts/d1_resource_worker.py')],{stdio:['pipe','pipe','ignore'],env:{PATH:process.env.PATH,LANG:'C.UTF-8',PYTHONIOENCODING:'utf-8',PYTHONDONTWRITEBYTECODE:'1'}});
    let pending=Buffer.alloc(0),sequence=0,result,failed=false,settled=false,processing=Promise.resolve();
    let killTimer;
    const stop=()=>{failed=true;child.kill('SIGTERM');killTimer??=setTimeout(()=>child.kill('SIGKILL'),10000);};
    const timer=setTimeout(stop,600000);
    const fail=()=>{if(!settled){settled=true;clearTimeout(timer);clearTimeout(killTimer);reject(Error('RESOURCE_BRIDGE_FAILED'));}};
    child.on('error',fail);child.stdin.on('error',()=>{failed=true;});
    child.stdout.on('data',chunk=>{
     pending=Buffer.concat([pending,chunk]);if(pending.length>LIMIT){stop();return;}
     let newline;
     while((newline=pending.indexOf(10))>=0){
      const line=pending.subarray(0,newline);pending=pending.subarray(newline+1);
      processing=processing.then(async()=>{
       if(failed)return;
       let message;try{message=JSON.parse(line.toString('utf8'));}catch{stop();return;}
       if(message.event==='check'&&Object.keys(message).sort().join(',')==='event,kind,sequence'&&message.sequence===sequence+1&&sequence<20000&&['ownership','target-safe'].includes(message.kind)&&result===undefined){
        sequence=message.sequence;let allowed=true;
        try{await assertExecutor();await assertOperation(action,input);if(message.kind==='target-safe')await assertTargetSafe(input);}catch{allowed=false;}
        if(!allowed)failed=true;
        if(!child.stdin.destroyed)child.stdin.write(JSON.stringify({sequence,allowed})+'\n');
       }else if(message.event==='result'&&Object.keys(message).sort().join(',')==='event,value'&&result===undefined&&message.value&&typeof message.value==='object'&&!Array.isArray(message.value))result=message.value;
       else stop();
      }).catch(stop);
     }
    });
    child.on('close',async code=>{
     await processing;clearTimeout(timer);clearTimeout(killTimer);child.stdin.destroy();
     if(failed||code!==0||pending.length||result===undefined||sequence<2){fail();return;}
     try{await assertExecutor();await assertOperation(action,input);}catch{fail();return;}
     if(!settled){settled=true;resolve(result);}
    });
    child.stdin.write(initial);
   });
  },
 };
}
module.exports={createResourceBridge};
