// A kernel lock keeper outlives every awaited stage in the callback. The helper
// inherits no cloud credentials; a broken keeper is never restarted in place.
const {spawn}=require('node:child_process');
const {randomBytes}=require('node:crypto');
const path=require('node:path');
async function acquire({directory,python='python3'}){
 if(typeof directory!=='string'||!path.isAbsolute(directory)||typeof python!=='string'||!python||python.includes('\0'))throw Error('RESOURCE_COORDINATOR_CONTEXT_REQUIRED');
 const owner=randomBytes(32).toString('hex');
 const child=spawn(python,[path.resolve(__dirname,'../../infra/scripts/d1_resource_coordinator_lock.py')],{stdio:['pipe','pipe','ignore'],env:{PATH:process.env.PATH,LANG:'C.UTF-8',PYTHONIOENCODING:'utf-8',PYTHONDONTWRITEBYTECODE:'1'}});
 let buffer=Buffer.alloc(0),pending,dead=false,ready=false,released=false,sequence=0,tail=Promise.resolve(),killTimer;
 const closed=new Promise(resolve=>child.once('close',(code,signal)=>resolve({code,signal})));
 function stop(){dead=true;child.kill('SIGTERM');killTimer??=setTimeout(()=>child.kill('SIGKILL'),10000);killTimer.unref();}
 function fail(error=Error('RESOURCE_COORDINATOR_KEEPER_LOST')){dead=true;if(pending){const current=pending;pending=null;clearTimeout(current.timer);current.reject(error);}}
 function expect(event,write){
  if(dead||pending) return Promise.reject(Error('RESOURCE_COORDINATOR_KEEPER_LOST'));
  return new Promise((resolve,reject)=>{
   pending={event,resolve,reject,timer:setTimeout(()=>{fail(Error('RESOURCE_COORDINATOR_KEEPER_TIMEOUT'));stop();},30000)};
   if(write)child.stdin.write(JSON.stringify(write)+'\n');
  });
 }
 child.on('error',()=>fail());child.stdin.on('error',()=>{fail();stop();});
 child.on('close',()=>{clearTimeout(killTimer);if(!released)fail();});
 child.stdout.on('data',chunk=>{
  buffer=Buffer.concat([buffer,chunk]);if(buffer.length>8192){fail();stop();return;}
  let newline;while((newline=buffer.indexOf(10))>=0){
   const line=buffer.subarray(0,newline);buffer=buffer.subarray(newline+1);let value;
   try{value=JSON.parse(line.toString('utf8'));}catch{fail();stop();return;}
   if(value?.event==='error'&&/^RESOURCE_[A-Z0-9_]+$/.test(value.code??'')){fail(Error(value.code));stop();return;}
   const keys=ready?'event,owner,sequence':'event,owner';
   if(!pending||Object.keys(value??{}).sort().join(',')!==keys||value.event!==pending.event||value.owner!==owner||ready&&value.sequence!==sequence){fail();stop();return;}
   if(!ready)ready=true;if(value.event==='released')released=true;
   const current=pending;pending=null;clearTimeout(current.timer);current.resolve();
  }
 });
 try{await expect('ready',{version:1,directory,parentPid:process.pid,owner});}
 catch(error){stop();await closed;clearTimeout(killTimer);throw error;}
 function command(action){
  const operation=tail.then(async()=>{
   if(dead||released)throw Error('RESOURCE_COORDINATOR_KEEPER_LOST');sequence++;
   await expect(action==='check'?'checked':'released',{action,sequence,owner});
  });tail=operation.catch(()=>{});return operation;
 }
 return{
  assertLocked:()=>command('check'),
  async release(){
   try{await command('release');child.stdin.end();const end=await closed;if(end.code!==0||buffer.length)throw Error('RESOURCE_COORDINATOR_KEEPER_LOST');}
   catch(error){stop();await closed;throw error;}
   finally{clearTimeout(killTimer);}
  },
 };
}
async function withResourceLock(options,work){
 if(typeof work!=='function')throw Error('RESOURCE_COORDINATOR_CALLBACK_REQUIRED');
 const lock=await acquire(options);let value,error,failed=false;
 try{await lock.assertLocked();value=await work({assertLocked:lock.assertLocked});await lock.assertLocked();}catch(caught){error=caught;failed=true;}
 try{await lock.release();}catch(caught){if(!failed){error=caught;failed=true;}}
 if(failed)throw error;return value;
}
module.exports={withResourceLock};
