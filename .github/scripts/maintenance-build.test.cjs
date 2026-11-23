const test=require('node:test'),assert=require('node:assert/strict');
const {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync}=require('node:fs');
const {join}=require('node:path'),{tmpdir}=require('node:os');
const {buildMaintenance}=require('./maintenance-build.cjs');
test('relative build output becomes absolute and the real upload-only artifact is validated without credentials',()=>{
 const root=mkdtempSync(join(tmpdir(),'maintenance-build-')),calls=[];
 try{
  const out=buildMaintenance({root,outdir:'artifact',env:{PATH:'/synthetic/bin',HOME:'/synthetic/home',CLOUDFLARE_API_TOKEN:'never-forward',AWS_SECRET_ACCESS_KEY:'never-forward',ACTIONS_ID_TOKEN_REQUEST_TOKEN:'never-forward',NODE_OPTIONS:'never-forward'},execute:(command,args,options)=>{
   calls.push({command,args,options});assert.equal(command,process.execPath);assert.equal(options.cwd,root);
   for(const key of ['CLOUDFLARE_API_TOKEN','AWS_SECRET_ACCESS_KEY','ACTIONS_ID_TOKEN_REQUEST_TOKEN','NODE_OPTIONS'])assert.equal(options.env[key],undefined);
   assert.equal(options.env.WRANGLER_SEND_METRICS,'false');assert.ok(args.includes('--dry-run'));
   if(calls.length===1){assert.equal(args[args.indexOf('--outdir')+1],join(root,'artifact'));mkdirSync(join(root,'artifact'));writeFileSync(join(root,'artifact/worker.js'),'export default {};');}
   else{assert.ok(args.includes('--no-bundle'));const config=JSON.parse(readFileSync(args[args.indexOf('--config')+1],'utf8'));assert.equal(config.main,join(root,'artifact/worker.js'));assert.equal(config.vars.MAINTENANCE_ENABLED,'false');}
  }});
  assert.equal(out,join(root,'artifact'));assert.equal(calls.length,2);
 }finally{rmSync(root,{recursive:true,force:true});}
});
test('README-only output fails before upload-only validation or artifact publication',()=>{
 const root=mkdtempSync(join(tmpdir(),'maintenance-empty-'));let calls=0;
 try{assert.throws(()=>buildMaintenance({root,outdir:'artifact',execute:()=>{calls++;mkdirSync(join(root,'artifact'));writeFileSync(join(root,'artifact/README.md'),'not a worker');}}),/ENOENT/);assert.equal(calls,1);}finally{rmSync(root,{recursive:true,force:true});}
});
test('a missing output path or repository root cannot be used as the artifact directory',()=>{
 for(const outdir of [undefined,'',' ','.'])assert.throws(()=>buildMaintenance({outdir,execute:()=>assert.fail('no build')}),/DIRECTORY_REQUIRED/);
});
