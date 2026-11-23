'use strict';
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {spawnSync}=require('node:child_process');
const work=fs.mkdtempSync(path.join(os.tmpdir(),'videoq-foundation-'));
try {
 for (const root of ['infra/r2-state','infra/cloudflare']) {
  function tf(args,json=false) {
   const result=spawnSync('terraform',['-chdir='+root,...args],{encoding:'utf8',maxBuffer:64*1024*1024});
   fs.writeFileSync(path.join(work,root.replaceAll('/','-')+'-'+args[0]+'.log'),result.stdout+result.stderr,{mode:0o600});
   if(result.status!==0)throw Error(`Terraform ${args[0]} failed for ${root}; raw state and plan values remain private.`);
   return json?JSON.parse(result.stdout):undefined;
  }
  tf(['init','-lockfile=readonly','-input=false']);
  const plan=path.join(work,root.replaceAll('/','-')+'.tfplan');
  tf(['plan','-input=false','-out='+plan]);
  const data=tf(['show','-json',plan],true);
  const changes=(data.resource_changes||[]).filter(r=>r.change.actions.join()!=='no-op');
  for(const resource of changes)console.log(`${root}: ${resource.address}: ${resource.change.actions.join(', ')}`);
  if(!changes.length)console.log(`${root}: no infrastructure changes.`);
  if(process.env.APPLY==='true')tf(['apply','-input=false',plan]);
 }
} catch(error) {console.error(error.message);process.exitCode=1;}
finally {fs.rmSync(work,{recursive:true,force:true});}
