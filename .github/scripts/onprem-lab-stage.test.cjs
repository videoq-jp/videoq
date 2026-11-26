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

test('diagnostic storage failures preserve original request error at every report stage', async () => {
 const {labStage} = await import('../onprem-lab/stage.mjs');
 for (const failingStatus of ['started','failed']) {
  const rows=[];const original=new DOMException('private-primary','TimeoutError');
  await assert.rejects(labStage('chat.send', async()=>{throw original}, row=>{
   rows.push(row);if(row.status===failingStatus)throw Object.assign(new Error('private-storage-path'),{code:'ENOSPC'});
  }), error=>error===original);
  assert.deepEqual(rows.map(row=>row.status),['started','failed']);
  assert.equal(rows[1].timeout,true);
 }
});
test('started and success reporter failures do not classify successful requests as failed', async () => {
 const {labStage} = await import('../onprem-lab/stage.mjs');
 for (const failingStatus of ['started','passed']) {
  const rows=[];const value={result:'private-result'};
  assert.equal(await labStage('chat.stream', async()=>value, row=>{
   rows.push(row);if(row.status===failingStatus)throw new Error('private-rename-path');
  }),value);
  assert.deepEqual(rows.map(row=>row.status),['started','passed']);
 }
});
test('SSE progress preserves complete body and retains only fixed categories and timings', async()=>{
 const {readSseBody}=await import('../onprem-lab/stage.mjs');const rows=[];
 const body='data: {"type":"tool_progress","status":"running","tool":"private-tool","call_id":123}\n\ndata: {"type":"private-type","text":"private-payload"}\n\ndata: {"type":"text_delta","text":"日本語"}\n\ndata: {"type":"done","feedback_token":"private-token"}\n\n';
 assert.equal(await readSseBody(new Response(body),performance.now(),row=>rows.push(row)),body);
 const final=rows.at(-1);assert.equal(final.eventCount,4);assert.equal(final.eventCounters.tool_progress,1);assert.equal(final.eventCounters.other,1);assert.equal(final.toolStatusCounters.running,1);
 assert(final.headersElapsedMilliseconds>=0);assert(final.firstEventElapsedMilliseconds>=final.headersElapsedMilliseconds);assert(final.lastEventElapsedMilliseconds>=final.firstEventElapsedMilliseconds);
 assert(!JSON.stringify(rows).includes('private'));assert(!JSON.stringify(rows).includes('日本語'));
});
test('partial SSE body abort atomically retains progress without payloads',async()=>{
 const {readSseBody,stageReporter}=await import('../onprem-lab/stage.mjs');
 const {mkdtempSync,readFileSync,rmSync}=require('node:fs');const {join}=require('node:path');const {tmpdir}=require('node:os');
 const directory=mkdtempSync(join(tmpdir(),'lab-sse-'));const path=join(directory,'stages.json');
 const server=require('node:http').createServer((request,response)=>{response.writeHead(200,{'Content-Type':'text/event-stream'});response.write('data: {"type":"tool_progress","status":"complete","arguments":"private-arguments"}\n\n');});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 try{
  const started=performance.now();const response=await fetch(`http://127.0.0.1:${server.address().port}`,{signal:AbortSignal.timeout(150)});
  await assert.rejects(readSseBody(response,started,stageReporter(path,'restore-and-upgrade')),error=>error.name==='TimeoutError');
  const rows=JSON.parse(readFileSync(path,'utf8')).stages;const final=rows.at(-1);
  assert.equal(final.eventCount,1);assert.equal(final.eventCounters.tool_progress,1);assert.equal(final.toolStatusCounters.complete,1);assert(final.lastEventElapsedMilliseconds!==null);assert(!JSON.stringify(rows).includes('private-arguments'));
 }finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));rmSync(directory,{recursive:true,force:true});}
});
test('SSE diagnostic IO failures preserve original read errors and successful bodies',async()=>{
 const {readSseBody}=await import('../onprem-lab/stage.mjs');
 const original=new DOMException('private-error','TimeoutError');let reads=0;
 const response={body:{getReader:()=>({read:async()=>{if(reads++===0)return{value:new TextEncoder().encode('data: {"type":"citation","sourceId":"private-id"}\n'),done:false};throw original;},releaseLock:()=>{throw new Error('private-release')}})}};
 await assert.rejects(readSseBody(response,performance.now(),()=>{throw new Error('private-ENOSPC')}),error=>error===original);
 const body='data: {"type":"done"}\n';assert.equal(await readSseBody(new Response(body),performance.now(),()=>{throw new Error('private-rename')}),body);
});

test('SSE diagnostics handle fragmented UTF8 and malformed category fields without changing body',async()=>{
 const {readSseBody}=await import('../onprem-lab/stage.mjs');const rows=[];
 const body='data: {"type":{"toString":"private"}}\n\ndata: {"type":"tool_progress","status":{"toString":"private"}}\n\ndata: {"type":"text_delta","text":"日本語"}\n';
 const bytes=new TextEncoder().encode(body);let offset=0;
 const response=new Response(new ReadableStream({pull(controller){if(offset===bytes.length){controller.close();return;}controller.enqueue(bytes.slice(offset,++offset));}}));
 assert.equal(await readSseBody(response,performance.now(),row=>rows.push(row)),body);
 assert.equal(rows.at(-1).eventCount,3);assert.equal(rows.at(-1).eventCounters.other,1);
 assert.deepEqual(rows.at(-1).toolStatusCounters,{running:0,complete:0,error:0});assert(!JSON.stringify(rows).includes('private'));
 assert.equal(await readSseBody({body:null},performance.now(),()=>{}),'');
});
