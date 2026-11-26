// Keep the node --test entry point and register with Vitest discovery.
const { test } = await import(process.env.VITEST === 'true' ? 'vitest' : 'node:test');
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {execFileSync} from 'node:child_process';
test('missing SQL metadata remains unknown while observed subsets and coverage are retained',()=>{
 const dir=mkdtempSync(tmpdir()+'/videoq-summary-test-');
 try {
  const sample={status:200,quality:{ok:true},clientElapsedMs:1,trace:{queries:2,unavailableReadMetadata:1,reads:7,sql:{unknown:{calls:1,elapsedMs:1,rowsRead:0,rowsWritten:0,metadataUnavailable:1},known:{calls:1,elapsedMs:1,rowsRead:7,rowsWritten:2,metadataUnavailable:0}}}};
  writeFileSync(dir+'/input.json',JSON.stringify({operations:[{command:'measure',result:{limits:[],cells:[{tenantVideoCount:1,concurrency:1,coldLogical:sample,samples:[]}]}}]}));
  execFileSync(process.execPath,[new URL('./summarize.mjs',import.meta.url).pathname,dir+'/input.json',dir+'/output.json']);
  const result=JSON.parse(readFileSync(dir+'/output.json'));
  const unknown=result.sqlOperations.find(row=>row.hash==='unknown'),known=result.sqlOperations.find(row=>row.hash==='known');
  assert.equal(unknown.rowsRead,null);assert.equal(unknown.rowsWritten,null);assert.equal(unknown.metadataCovered,0);assert.equal(unknown.metadataUnavailable,1);assert.equal(unknown.knownSubsetRowsRead,0);
  assert.equal(known.rowsRead,7);assert.equal(known.rowsWritten,2);assert.equal(known.metadataCovered,1);
  assert.equal(result.cells[0].totalRowsRead,null);assert.equal(result.cells[0].knownSubsetRowsRead,7);
 } finally {rmSync(dir,{recursive:true,force:true});}
});
