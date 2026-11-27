import {fileURLToPath} from 'node:url';
import { build } from 'esbuild';
import { expect,it } from 'vitest';
import { createD1Fixture } from './d1-fixture';

it.each(['fail','stop','invalid','rate','spoof','unknown'])('restarts a real isolated %s workflow with ledger/artifact/publication reconciliation',async(mode)=>{
  const bundle=await build({entryPoints:[fileURLToPath(new URL('./search-recovery-fixture.worker.ts',import.meta.url))],bundle:true,write:false,format:'esm',platform:'node',external:['cloudflare:*','node:*','pg-native'],banner:{js:'import {createRequire} from "node:module";const require=createRequire("/worker.mjs");'},target:'es2022'});
  const fixture=await createD1Fixture({r2:true,workflowScript:bundle.outputFiles[0].text});
  try {
    const db=fixture.database;
    await db.prepare('CREATE TABLE recovery_probe(mode TEXT)').run();await db.prepare('INSERT INTO recovery_probe VALUES(?)').bind(mode).run();
    await db.prepare("INSERT INTO users(id,username,email,is_over_quota,used_ai_answers,used_processing_seconds,used_storage_bytes) VALUES('owner','owner','recovery@example.invalid',0,0,0,0)").run();
    await db.prepare("INSERT INTO videos(id,user_id,title,file,description,uploaded_at,transcript,status,error_message,source_type,source_url,youtube_video_id) VALUES(1,'owner','Synthetic','','','2026-01-01',?,'completed','','uploaded','','')").bind(mode==='invalid'?'private malformed transcript':'1\n00:00:00,000 --> 00:00:01,000\n標本化とは\n').run();
    const call=(path:string,body?:string)=>fixture.runtime.dispatchFetch(`http://localhost${path}`,{method:body?'POST':'GET',body});
    const wait=async(status:string)=>{for(let n=0;n<600;n++){const result=await(await call('/status')).json() as {status:string};if(result.status===status)return;await new Promise(resolve=>setTimeout(resolve,50));}throw new Error(`Workflow did not reach ${status}`);};
    expect((await call('/create')).ok).toBe(true);
    if(mode==='invalid'){await wait('errored');expect(await db.prepare("SELECT last_error FROM job_executions WHERE job_id='isolated-recovery'").first('last_error')).toBe('INVALID_TRANSCRIPT');return;}
    if(['fail','rate','spoof','unknown'].includes(mode)) await wait('errored'); else {expect((await call('/terminate')).ok).toBe(true);await wait('terminated');}
    expect(JSON.stringify(await(await call('/status')).json())).not.toContain('private');
    const inspection=await(await call('/inspect')).json() as {inspection:string;artifacts:unknown[]};
    expect(inspection.inspection).toMatch(/^[a-f0-9]{64}$/);
    if(mode==='spoof' || mode==='unknown')expect(await db.prepare("SELECT last_error FROM job_executions WHERE job_id='isolated-recovery'").first('last_error')).toBe('WORKER_EXECUTION_FAILED');
    if(mode==='rate')expect(await db.prepare("SELECT last_error FROM job_executions WHERE job_id='isolated-recovery'").first('last_error')).toBe('PROVIDER_RATE_LIMITED');
    if(['fail','rate','spoof','unknown'].includes(mode)) {expect(inspection.artifacts.length).toBeGreaterThan(0);expect(await db.prepare("SELECT status FROM job_executions WHERE job_id='isolated-recovery'").first('status')).toBe('failed');}
    expect((await call('/restart','0'.repeat(64))).status).toBe(409);
    await db.prepare("UPDATE recovery_probe SET mode='run'").run();
    const restart=await call('/restart',inspection.inspection);expect(await restart.json()).toMatchObject({outcome:'restart_accepted'});
    await wait('complete');
    expect(await db.prepare("SELECT status FROM job_executions WHERE job_id='isolated-recovery'").first('status')).toBe('completed');
    expect(await db.prepare('SELECT count(*) AS n FROM video_index_heads').first('n')).toBe(1);
    const objects=await fixture.bucket!.list({prefix:'internal/search-index/'});expect(objects.objects).toHaveLength(0);
    const auditObjects=await fixture.bucket!.list({prefix:'internal/search-recovery/'});expect(auditObjects.objects).toHaveLength(1);
    const audit=await(await fixture.bucket!.get(auditObjects.objects[0].key))!.text();expect(JSON.parse(audit).outcome).toBe('restart_accepted');expect(audit).not.toContain('標本化');expect(audit).not.toContain('private');
    expect((await call('/inspect')).status).toBe(409);
  } finally {await fixture.dispose();}
},60_000);
