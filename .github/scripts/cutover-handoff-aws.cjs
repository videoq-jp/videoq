// Extra authority exists only in the reviewed local backend/finalizer entry.
// The original metadata/admission transport continues denying Lambda writes.
'use strict';
const {execFileSync}=require('node:child_process');
const {mkdtempSync,writeFileSync,rmSync}=require('node:fs');
const {join}=require('node:path');
const {tmpdir}=require('node:os');
const {createAwsTransport,executionEnv}=require('./run-cutover-admission.cjs');
function createHandoffAwsTransport({execute=execFileSync,env=process.env,root=join(__dirname,'../..')}={}){
 const metadata=createAwsTransport({execute,env,root});
 return async(service,command,input)=>{
  const special={lambda:{GetFunctionConfiguration:'get-function-configuration',UpdateFunctionConfiguration:'update-function-configuration',UpdateEventSourceMapping:'update-event-source-mapping'},scheduler:{GetSchedule:'get-schedule'}};
  if(!special[service]?.[command])return metadata(service,command,input);
  if(service==='lambda'&&command!=='UpdateEventSourceMapping'&&(!['videoq-worker-prod','videoq-worker-search-prod','videoq-worker-account-prod'].includes(input.FunctionName)||Object.keys(input).some(k=>!(command==='GetFunctionConfiguration'?['FunctionName']:['FunctionName','RevisionId','Environment']).includes(k))))throw Error('FIXED_HANDOFF_WORKER_REQUIRED');
  if(command==='UpdateFunctionConfiguration'&&(typeof input.RevisionId!=='string'||!input.RevisionId||!input.Environment?.Variables))throw Error('CAS_WORKER_ENVIRONMENT_REQUIRED');
  if(command==='UpdateEventSourceMapping'&&(!/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(input.UUID??'')||typeof input.Enabled!=='boolean'||Object.keys(input).some(k=>!['UUID','Enabled'].includes(k))))throw Error('FIXED_HANDOFF_MAPPING_REQUIRED');
  if(service==='scheduler'&&(input.Name!=='videoq-db-maintenance-prod'||input.GroupName!=='default'||Object.keys(input).length!==2))throw Error('FIXED_NEON_SCHEDULE_REQUIRED');
  const directory=mkdtempSync(join(tmpdir(),'videoq-handoff-metadata-')),file=join(directory,'input.json');
  try{writeFileSync(file,JSON.stringify(input),{mode:0o600});return JSON.parse(execute('aws',[service,special[service][command],'--region','ap-northeast-1','--output','json','--no-cli-pager','--cli-input-json','file://'+file],{cwd:root,env:{...executionEnv(env,'aws'),AWS_IGNORE_CONFIGURED_ENDPOINT_URLS:'true',AWS_PAGER:''},encoding:'utf8',stdio:['ignore','pipe','pipe'],timeout:30000,maxBuffer:4*1024*1024}));}finally{rmSync(directory,{recursive:true,force:true});}
 };
}
module.exports={createHandoffAwsTransport};
