// Private durable execution identity. No Cloudflare/app/model credentials or
// customer rows. A claimed run cannot regenerate a missing executor capability.
const fs=require('node:fs/promises'),{constants}=require('node:fs'),path=require('node:path'),{randomBytes}=require('node:crypto');
const {resourceDigest}=require('./d1-resource-journal.cjs');
const TABLE='videoq-db-maintenance-prod',LIMIT=8192,HEX=/^[a-f0-9]{64}$/;
const INPUT=['run','source','definitionSha256','projectSha256','platformSha256'];
const KEYS=[...INPUT,'version','executorToken','artifactRoot','rootDevice','rootInode'];
function input(value){if(!value||Object.keys(value).sort().join(',')!==[...INPUT].sort().join(',')||!/^[a-f0-9]{32}$/.test(value.run??'')||!/^[a-f0-9]{40}$/.test(value.source??'')||['definitionSha256','projectSha256','platformSha256'].some(k=>!HEX.test(value[k]??'')))throw Error('RESOURCE_CONTEXT_INPUT_REQUIRED');return value;}
async function createResourceContextStore({directory,aws}){
 if(typeof directory!=='string'||!path.isAbsolute(directory)||aws!==undefined&&typeof aws!=='function')throw Error('RESOURCE_CONTEXT_DIRECTORY_REQUIRED');
 const root=await fs.realpath(directory),original=await fs.lstat(directory,{bigint:true});
 const privateDirectory=v=>v.isDirectory()&&!v.isSymbolicLink()&&(v.mode&0o777n)===0o700n&&v.uid===BigInt(process.getuid());
 if(!privateDirectory(original))throw Error('RESOURCE_CONTEXT_DIRECTORY_REQUIRED');
 const filename=path.join(root,'resource-context.json');
 async function checked(){const current=await fs.lstat(root,{bigint:true});if(!privateDirectory(current)||current.dev!==original.dev||current.ino!==original.ino)throw Error('RESOURCE_CONTEXT_DIRECTORY_CHANGED');}
 function validate(value){
  if(!value||Object.keys(value).sort().join(',')!==[...KEYS].sort().join(',')||value.version!==1||!HEX.test(value.executorToken??'')||value.artifactRoot!==root||value.rootDevice!==String(original.dev)||value.rootInode!==String(original.ino))throw Error('RESOURCE_CONTEXT_RECORD_REQUIRED');
  input(Object.fromEntries(INPUT.map(k=>[k,value[k]])));return value;
 }
 async function load(){
  await checked();let handle;try{handle=await fs.open(filename,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);}catch(error){if(error.code==='ENOENT')return null;throw Error('RESOURCE_CONTEXT_FILE_UNSAFE');}
  try{
   const before=await handle.stat({bigint:true});if(!before.isFile()||(before.mode&0o777n)!==0o600n||before.uid!==original.uid||before.size>BigInt(LIMIT))throw Error('RESOURCE_CONTEXT_FILE_UNSAFE');
   const bytes=Buffer.alloc(LIMIT+1);let stable=false,bytesRead=0,previous=before;
   for(let attempt=0;attempt<3;attempt++){
    ({bytesRead}=await handle.read(bytes,0,bytes.length,0));const after=await handle.stat({bigint:true});
    if(BigInt(bytesRead)!==previous.size||previous.size!==after.size||previous.mtimeNs!==after.mtimeNs||previous.ino!==after.ino||previous.dev!==after.dev||previous.mode!==after.mode||previous.uid!==after.uid)throw Error('RESOURCE_CONTEXT_FILE_CHANGED');
    if(previous.ctimeNs===after.ctimeNs){stable=true;break;}
    // Publishing/removing the temporary hard link changes ctime on this same
    // inode. Never accept that read: require another full, stable observation.
    previous=after;
   }
   if(!stable)throw Error('RESOURCE_CONTEXT_FILE_CHANGED');
   let value;try{value=JSON.parse(bytes.subarray(0,bytesRead).toString('utf8'));}catch{throw Error('RESOURCE_CONTEXT_RECORD_REQUIRED');}
   await checked();return validate(value);
  }finally{await handle.close();}
 }
 function same(value,expected){if(INPUT.some(k=>value[k]!==expected[k]))throw Error('RESOURCE_CONTEXT_PIN_MISMATCH');return value;}
 async function unclaimed(expected){
  if(typeof aws!=='function')throw Error('RESOURCE_CONTEXT_BOOTSTRAP_TRANSPORT_REQUIRED');
  const arn='arn:aws:states:ap-northeast-1:257240362763:execution:videoq-db-maintenance-prod:db-'+expected.run;
  const [run,owner,execution,bound]=await Promise.all([aws('ddb','GetItem',{TableName:TABLE,Key:{pk:{S:'run#'+expected.run}},ConsistentRead:true}),aws('ddb','GetItem',{TableName:TABLE,Key:{pk:{S:'maintenance'}},ConsistentRead:true}),aws('sfn','DescribeExecution',{executionArn:arn}),aws('sfn','DescribeStateMachineForExecution',{executionArn:arn})]);
  const row=run.Item;let spec;try{spec=JSON.parse(bound.definition);}catch{throw Error('RESOURCE_CONTEXT_HOLD_REQUIRED');}
  if(row?.kind?.S!=='d1-resource-hold'||row.execution_arn?.S!==arn||row.source_sha?.S!==expected.source||row.resource_phase?.S!=='holding'||row.release_requested?.BOOL!==false||owner.Item?.kind?.S!=='d1-resource-hold'||owner.Item.execution_arn?.S!==arn||execution.status!=='RUNNING'||resourceDigest(spec)!==expected.definitionSha256)throw Error('RESOURCE_CONTEXT_HOLD_REQUIRED');
  if(row.resource_executor_sha256!==undefined||row.resource_steps!==undefined||row.resource_steps_sha256!==undefined||row.resource_abort_requested!==undefined||row.resource_revision?.N!=='0')throw Error('RESOURCE_CONTEXT_RUN_ALREADY_CLAIMED');
 }
 async function sync(){const dir=await fs.open(root,constants.O_RDONLY|constants.O_NOFOLLOW);try{await dir.sync();}finally{await dir.close();}}
 return{
  load,
  async loadRequired(expected){
   if(!expected||Object.keys(expected).sort().join(',')!=='run,source'||!/^[a-f0-9]{32}$/.test(expected.run??'')||!/^[a-f0-9]{40}$/.test(expected.source??''))throw Error('RESOURCE_CONTEXT_LOOKUP_REQUIRED');
   const value=await load();if(!value)throw Error('RESOURCE_CONTEXT_FILE_REQUIRED');if(value.run!==expected.run||value.source!==expected.source)throw Error('RESOURCE_CONTEXT_PIN_MISMATCH');return value;
  },
  async initialize(expected){
   input(expected);const prior=await load();if(prior)return{created:false,context:same(prior,expected)};
   await unclaimed(expected);await checked();
   const value=validate({...expected,version:1,executorToken:randomBytes(32).toString('hex'),artifactRoot:root,rootDevice:String(original.dev),rootInode:String(original.ino)}),temporary=path.join(root,'.resource-context-'+randomBytes(16).toString('hex')+'.partial');
   let handle,identity,published=false;
   try{
    handle=await fs.open(temporary,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);identity=await handle.stat({bigint:true});await handle.writeFile(JSON.stringify(value)+'\n');await handle.sync();await checked();
    const current=await fs.lstat(temporary,{bigint:true});if(!current.isFile()||current.dev!==identity.dev||current.ino!==identity.ino)throw Error('RESOURCE_CONTEXT_TEMPORARY_CHANGED');
    try{await fs.link(temporary,filename);published=true;}catch(error){if(error.code!=='EEXIST')throw Error('RESOURCE_CONTEXT_PUBLICATION_UNCERTAIN');}
    await sync();const stored=await load();if(!stored)throw Error('RESOURCE_CONTEXT_PUBLICATION_UNCERTAIN');same(stored,expected);
    if(published&&resourceDigest(stored)!==resourceDigest(value))throw Error('RESOURCE_CONTEXT_PUBLICATION_UNCERTAIN');return{created:published,context:stored};
   }finally{
    await handle?.close();
    if(identity){await checked();const current=await fs.lstat(temporary,{bigint:true});if(current.dev!==identity.dev||current.ino!==identity.ino)throw Error('RESOURCE_CONTEXT_TEMPORARY_CHANGED');await fs.unlink(temporary);await sync();}
   }
  },
  async summary(expected){const value=await this.loadRequired(expected);return{version:1,run:value.run,source:value.source,definitionSha256:value.definitionSha256,projectSha256:value.projectSha256,platformSha256:value.platformSha256,executorSha256:resourceDigest({executorToken:value.executorToken})};},
 };
}
module.exports={createResourceContextStore};
