const {test} = require('node:test');
const assert = require('node:assert/strict');
test('stage preserves success and reports bounded labels', async () => {
 const {labStage} = await import('../onprem-lab/stage.mjs');
 const rows=[]; const secret={cookie:'private-cookie'};
 assert.equal(await labStage('chat.send', async()=>secret, row=>rows.push(row)),secret);
 assert.deepEqual(rows.map(row=>row.status),['started','passed']);
 assert(!JSON.stringify(rows).includes('private-cookie'));
});
test('stage preserves timeout identity without disclosing request or error data', async () => {
 const {labStage} = await import('../onprem-lab/stage.mjs');
 const rows=[]; const error=new DOMException('private-question-and-cookie','TimeoutError');
 await assert.rejects(labStage('chat.stream', async()=>{throw error}, row=>rows.push(row)), value=>value===error);
 assert.deepEqual(rows.map(row=>row.status),['started','failed']);
 assert.equal(rows[1].timeout,true);
 assert(!JSON.stringify(rows).includes('private-question'));
});

test('actual aborted request retains atomic sanitized failure progress', async () => {
 const {labStage, stageReporter} = await import('../onprem-lab/stage.mjs');
 const {mkdtempSync, readFileSync, existsSync, rmSync} = require('node:fs');
 const {tmpdir} = require('node:os'); const {join} = require('node:path');
 const directory=mkdtempSync(join(tmpdir(),'lab-stage-')); const path=join(directory,'progress.json');
 const server=require('node:http').createServer((request,response)=>{response.writeHead(200);response.write('private-response');});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 try {
  await assert.rejects(labStage('chat.stream', async()=>{
   const response=await fetch(`http://127.0.0.1:${server.address().port}`, {signal:AbortSignal.timeout(100)});
   await response.text();
  },stageReporter(path,'restore-and-upgrade')));
  const receipt=JSON.parse(readFileSync(path,'utf8'));
  assert.deepEqual(receipt.stages.map(row=>row.status),['started','failed']);
  assert.equal(receipt.stages[1].timeout,true);
  assert.equal(receipt.stages[1].mode,'restore-and-upgrade');
  assert(!JSON.stringify(receipt).includes('private-response'));
  assert.equal(existsSync(path+'.tmp'),false);
 } finally {server.closeAllConnections();await new Promise(resolve=>server.close(resolve));rmSync(directory,{recursive:true,force:true});}
});
test('actual fetch rejection retains original error and safe classification', async () => {
 const {labStage} = await import('../onprem-lab/stage.mjs');
 const rows=[];
 await assert.rejects(labStage('restore.videos.get', ()=>fetch('http://127.0.0.1:1/private-token'), row=>rows.push(row)), TypeError);
 assert.equal(rows[1].status,'failed');assert.equal(rows[1].timeout,false);
 assert(!JSON.stringify(rows).includes('private-token'));
});
