const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os');
const {createResourceContextStore}=require('./d1-resource-context.cjs');
const {resourceDigest}=require('./d1-resource-journal.cjs');
async function fixture(t){
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'videoq-run-context-'));t.after(()=>fs.rm(directory,{recursive:true,force:true}));
 const spec={States:{wait:{Type:'Wait',Seconds:10}}},expected={run:'a'.repeat(32),source:'b'.repeat(40),definitionSha256:resourceDigest(spec),projectSha256:'c'.repeat(64),platformSha256:'d'.repeat(64)},arn='arn:aws:states:ap-northeast-1:257240362763:execution:videoq-db-maintenance-prod:db-'+expected.run;
 const row={kind:{S:'d1-resource-hold'},execution_arn:{S:arn},source_sha:{S:expected.source},resource_phase:{S:'holding'},release_requested:{BOOL:false},resource_revision:{N:'0'}},owner={kind:{S:'d1-resource-hold'},execution_arn:{S:arn}},calls=[];let status='RUNNING';
 const aws=async(service,command,input)=>{calls.push({service,command,input});if(command==='GetItem')return{Item:structuredClone(input.Key.pk.S==='maintenance'?owner:row)};if(command==='DescribeExecution')return{status};assert.equal(command,'DescribeStateMachineForExecution');return{definition:JSON.stringify(spec)};};
 return{directory,expected,row,owner,calls,store:await createResourceContextStore({directory,aws}),stop:()=>status='SUCCEEDED'};
}
test('durable private context retains one executor capability and exposes only digest in summary',async t=>{
 const f=await fixture(t),first=await f.store.initialize(f.expected),again=await f.store.initialize(f.expected);assert.equal(first.created,true);assert.equal(again.created,false);assert.equal(resourceDigest(first.context),resourceDigest(again.context));assert.equal(first.context.executorToken.length,64);
 const summary=await f.store.summary({run:f.expected.run,source:f.expected.source});assert.equal(summary.executorSha256,resourceDigest({executorToken:first.context.executorToken}));assert.equal('executorToken' in summary,false);assert.equal(JSON.stringify(summary).includes(first.context.executorToken),false);
 assert.equal((await fs.stat(path.join(f.directory,'resource-context.json'))).mode&0o777,0o600);assert.deepEqual((await fs.readdir(f.directory)),['resource-context.json']);assert.ok(f.calls.every(v=>['GetItem','DescribeExecution','DescribeStateMachineForExecution'].includes(v.command)));
});
test('concurrent initializers publish exactly one immutable record without overwriting a winner',async t=>{
 const f=await fixture(t),results=await Promise.all([f.store.initialize(f.expected),f.store.initialize(f.expected)]);assert.equal(results.filter(v=>v.created).length,1);assert.equal(resourceDigest(results[0].context),resourceDigest(results[1].context));assert.deepEqual(await fs.readdir(f.directory),['resource-context.json']);
 await assert.rejects(f.store.initialize({...f.expected,projectSha256:'e'.repeat(64)}),/PIN_MISMATCH/);
});
test('missing context for a remotely claimed run cannot generate a new executor capability',async t=>{
 const f=await fixture(t);f.row.resource_executor_sha256={S:'e'.repeat(64)};await assert.rejects(f.store.initialize(f.expected),/ALREADY_CLAIMED/);assert.deepEqual(await fs.readdir(f.directory),[]);await assert.rejects(f.store.loadRequired({run:f.expected.run,source:f.expected.source}),/FILE_REQUIRED/);
});
test('lost hold, terminal execution, wrong source or prior journal refuses initialization',async t=>{
 for(const change of [f=>f.owner.execution_arn.S+='changed',f=>f.stop(),f=>f.row.source_sha.S='e'.repeat(40),f=>f.row.resource_steps={S:'[]'}]){const f=await fixture(t);change(f);await assert.rejects(f.store.initialize(f.expected));assert.deepEqual(await fs.readdir(f.directory),[]);}
});
test('copied context cannot authorize another artifact root and symlink context is refused',async t=>{
 const f=await fixture(t);await f.store.initialize(f.expected);const other=await fixture(t);await fs.copyFile(path.join(f.directory,'resource-context.json'),path.join(other.directory,'resource-context.json'));await assert.rejects(other.store.load(),/RECORD_REQUIRED/);
 await fs.unlink(path.join(other.directory,'resource-context.json'));await fs.symlink(path.join(f.directory,'resource-context.json'),path.join(other.directory,'resource-context.json'));await assert.rejects(other.store.load(),/FILE_UNSAFE/);
});
test('malformed file is retained and extra secret/data input fields cannot be published',async t=>{
 const f=await fixture(t);await assert.rejects(f.store.initialize({...f.expected,token:'forbidden'}),/INPUT_REQUIRED/);await fs.writeFile(path.join(f.directory,'resource-context.json'),'PRIVATE_MALFORMED_INPUT',{mode:0o600});await assert.rejects(f.store.load(),/RECORD_REQUIRED/);await assert.rejects(f.store.initialize(f.expected),/RECORD_REQUIRED/);assert.equal((await fs.stat(path.join(f.directory,'resource-context.json'))).size,23);
});
