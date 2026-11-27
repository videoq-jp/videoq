import { readFileSync, writeFileSync, mkdirSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { evaluateRun } from './result.mjs';
const root = resolve(import.meta.dirname, '../../../..');
const api = resolve(root,'apps/api');
const catalog = JSON.parse(readFileSync(resolve(root,'docs/architecture/ownership-behavioral-controls.json'),'utf8'));
const output = process.env.OWNERSHIP_REPORT_DIR ?? mkdtempSync(resolve(tmpdir(),'videoq-ownership-'));
mkdirSync(output,{recursive:true});
rmSync(resolve(output,'report.json'),{force:true});
const selected = process.argv.slice(2);
if (selected.some(id=>!catalog.controls.some(row=>row.id===id))) throw new Error('Unknown ownership control ID');
const rows = catalog.controls.filter(row => !selected.length || selected.includes(row.id));
const report = {schema:2, command:process.argv, startedAt:new Date().toISOString(), scope:'Reviewed failure witnesses between clean baseline and recovery runs; no semantic-duplication proof or general historical-copy coverage.', results:[]};
const sha = p => createHash('sha256').update(readFileSync(resolve(root,p))).digest('hex');
for (const row of rows) {
  if (JSON.stringify(row.modes)!==JSON.stringify(['bypass','ignore-result'])) throw new Error('Both reviewed mutation modes are required');
  const result = {...row, sourceSha256:sha(row.consumer), ownerSha256:sha(row.owner), testsSha256:Object.fromEntries(row.tests.map(p=>[p,sha('apps/api/'+p)])), runs:[]};
  const control = resolve(output,row.id+'.control.json');writeFileSync(control,JSON.stringify(row));
  for (const mode of ['baseline',...row.modes,'recovery']) {
    const prefix=resolve(output,`${row.id}.${mode}`), json=prefix+'.json', receipt=prefix+'.transform.json', completionFile=prefix+'.completion.json';
    for (const file of [json,receipt,completionFile]) rmSync(file,{force:true});
    const run=spawnSync(process.execPath,[resolve(root,'node_modules/vitest/vitest.mjs'),'run','--config','vitest.ownership.config.ts',...row.tests,'--reporter=json',`--reporter=${resolve(import.meta.dirname,'completion-reporter.mjs')}`,`--outputFile=${json}`],{
      cwd:api,env:{...process.env,OWNERSHIP_CONTROL:control,OWNERSHIP_MODE:mode==='recovery'?'baseline':mode,OWNERSHIP_TRANSFORM_RECEIPT:receipt,OWNERSHIP_COMPLETION_RECEIPT:completionFile},encoding:'utf8',maxBuffer:16*1024*1024,timeout:900_000,
    });
    writeFileSync(prefix+'.log',(run.stdout??'')+(run.stderr??''));
    const data=existsSync(json)?JSON.parse(readFileSync(json,'utf8')):null;
    const transformed=existsSync(receipt)?JSON.parse(readFileSync(receipt,'utf8')):null;
    const completion=existsSync(completionFile)?JSON.parse(readFileSync(completionFile,'utf8')):null;
    const evaluation=evaluateRun({mode,run,data,transformed,completion,witness:row.failureWitnesses?.[mode],baseline:result.runs[0],api});
    const {status}=evaluation;
    result.runs.push({mode,...evaluation,exitCode:run.status,signal:run.signal,processError:run.error?.message,transformed,completion,log:prefix+'.log'});
    console.log(row.id,mode,status,`passed=${data?.numPassedTests} failed=${data?.numFailedTests} skipped=${data?.numPendingTests}`,row.consumer);
    if (mode==='baseline' && status!=='passed') break;
  }
  report.results.push(result);writeFileSync(resolve(output,'report.json'),JSON.stringify(report,null,2)+'\n');
}
report.finishedAt=new Date().toISOString();writeFileSync(resolve(output,'report.json'),JSON.stringify(report,null,2)+'\n');
console.log('Report:',resolve(output,'report.json'));
process.exitCode=report.results.length>0 && report.results.every(r=>r.runs.length===r.modes.length+2 && r.runs.every(x=>['passed','detected'].includes(x.status)))?0:1;
