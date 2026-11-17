// Keep the real local lock around the entire awaited runtime invocation. Cloud
// credentials stay in the parent, never in the lock keeper's environment/argv.
const {withResourceLock}=require('./d1-resource-lock.cjs');
const {createResourceRuntime}=require('./d1-resource-runtime.cjs');
async function withLockedResourceRuntime(options,work){
 if(!options||options.enabled!==true)throw Error('RESOURCE_RUNTIME_DISABLED');
 if(typeof work!=='function'||['aws','cloudflare','lambda','github','assertRuntime','assertWorkersStopped'].some(k=>typeof options[k]!=='function')||typeof options.plans?.load!=='function'||typeof options.plans?.save!=='function')throw Error('RESOURCE_RUNTIME_CONTEXT_REQUIRED');
 return withResourceLock({directory:options.directory,python:options.python},async({assertLocked})=>{
  const guard=method=>async(...args)=>{await assertLocked();const value=await method(...args);await assertLocked();return value;};
  const runtime=createResourceRuntime({...options,
   aws:guard(options.aws),cloudflare:guard(options.cloudflare),lambda:guard(options.lambda),github:guard(options.github),
   plans:{load:guard(step=>options.plans.load(step)),save:guard((step,value)=>options.plans.save(step,value))},
   assertRuntime:guard(options.assertRuntime),assertWorkersStopped:guard(options.assertWorkersStopped),
  });
  const active=new Set();let closing=false;
  const facade=Object.fromEntries(['claim','advance','complete','abort'].map(name=>[name,(...args)=>{
   if(closing)return Promise.reject(Error('RESOURCE_COORDINATOR_KEEPER_LOST'));
   if(active.size)return Promise.reject(Error('RESOURCE_RUNTIME_OPERATION_IN_PROGRESS'));
   const operation=Promise.resolve().then(()=>runtime[name](...args));active.add(operation);
   operation.then(()=>active.delete(operation),()=>active.delete(operation));return operation;
  }]));
  try{return await work(facade);}
  finally{closing=true;await Promise.allSettled([...active]);}
 });
}
module.exports={withLockedResourceRuntime};
