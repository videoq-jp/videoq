import { readFileSync, writeFileSync, mkdirSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
const root = resolve(import.meta.dirname, '../../../..');
const api = resolve(root,'apps/api');
const catalog = JSON.parse(readFileSync(resolve(root,'docs/architecture/ownership-behavioral-controls.json'),'utf8'));
const output = process.env.OWNERSHIP_REPORT_DIR ?? mkdtempSync(resolve(tmpdir(),'videoq-ownership-'));
mkdirSync(output,{recursive:true});
const selected = process.argv.slice(2);
if (selected.some(id=>!catalog.controls.some(row=>row.id===id))) throw new Error('Unknown ownership control ID');
const rows = catalog.controls.filter(row => !selected.length || selected.includes(row.id));
const report = {schema:1, command:process.argv, startedAt:new Date().toISOString(), scope:'Explicit consumer-local bypass and ignored-result mutants; no semantic-duplication proof or general historical-copy coverage.', results:[]};
const sha = p => createHash('sha256').update(readFileSync(resolve(root,p))).digest('hex');
for (const row of rows) {
  const result = {...row, sourceSha256:sha(row.consumer), ownerSha256:sha(row.owner), testsSha256:Object.fromEntries(row.tests.map(p=>[p,sha('apps/api/'+p)])), runs:[]};
  const control = resolve(output,row.id+'.control.json');writeFileSync(control,JSON.stringify(row));
  for (const mode of ['baseline',...row.modes]) {
    const prefix=resolve(output,`${row.id}.${mode}`), json=prefix+'.json', receipt=prefix+'.transform.json';
    for (const file of [json,receipt]) rmSync(file,{force:true});
    const run=spawnSync(process.execPath,[resolve(root,'node_modules/vitest/vitest.mjs'),'run','--config','vitest.ownership.config.ts',...row.tests,'--reporter=json',`--outputFile=${json}`],{
      cwd:api,env:{...process.env,OWNERSHIP_CONTROL:control,OWNERSHIP_MODE:mode,OWNERSHIP_TRANSFORM_RECEIPT:receipt},encoding:'utf8',maxBuffer:16*1024*1024,
    });
    writeFileSync(prefix+'.log',(run.stdout??'')+(run.stderr??''));
    const data=existsSync(json)?JSON.parse(readFileSync(json,'utf8')):null;
    const transformed=existsSync(receipt)?JSON.parse(readFileSync(receipt,'utf8')):null;
    const failedAssertions=data?.testResults?.flatMap(s=>s.assertionResults??[]).filter(a=>a.status==='failed')??[];
    // Collection/import failures, no transformed site, skipped-only suites and
    // infrastructure crashes never count as detecting a behavioral mutant.
    const status=mode==='baseline' ? (run.status===0 && data?.numPassedTests>0 && transformed?.sites>0 ? 'passed':'invalid-baseline')
      : transformed?.sites>0 && data?.numPassedTests+data?.numFailedTests>0 && failedAssertions.length>0 && !data.testResults.some(s=>s.assertionResults?.length===0&&s.status==='failed') ? 'detected'
      : !transformed?.sites ? 'invalid-run' : run.status===0 ? 'survived':'invalid-run';
    result.runs.push({mode,status,exitCode:run.status,transformed,passed:data?.numPassedTests,failed:data?.numFailedTests,skipped:data?.numPendingTests,failedTests:failedAssertions.map(a=>a.fullName),log:prefix+'.log'});
    console.log(row.id,mode,status,`passed=${data?.numPassedTests} failed=${data?.numFailedTests} skipped=${data?.numPendingTests}`,row.consumer);
    if (mode==='baseline' && status!=='passed') break;
  }
  report.results.push(result);writeFileSync(resolve(output,'report.json'),JSON.stringify(report,null,2)+'\n');
}
report.finishedAt=new Date().toISOString();writeFileSync(resolve(output,'report.json'),JSON.stringify(report,null,2)+'\n');
console.log('Report:',resolve(output,'report.json'));
process.exitCode=report.results.every(r=>r.runs.length===r.modes.length+1 && r.runs.every(x=>['passed','detected'].includes(x.status)))?0:1;
