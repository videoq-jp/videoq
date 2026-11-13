import {createD1Fixture} from "./d1-fixture";
import {aiQuotaContract} from "./contracts/ai-quota.contract";
import {reserveAiAnswerUsage,releaseAiAnswerReservation} from "../../src/repositories/quota-repository";
import type {Bindings} from "../../src/types/bindings";
import {createD1ProcessingQuotaRepository} from "../../src/persistence/d1/processing-quota";
aiQuotaContract('D1 workerd',async()=>{
  const f=await createD1Fixture();
  const execute=async(sql:string,args:unknown[]=[])=>{await f.database.prepare(sql).bind(...args).run();};
  await execute(`INSERT INTO users(id,username,email,is_over_quota,used_ai_answers,used_processing_seconds,used_storage_bytes,used_upload_bytes,ai_answers_limit,usage_period_start,plan_code,quota_source)
    VALUES ('owner','owner','owner@example.test',0,0,0,0,55,3,?,'basic','admin')`,[new Date().toISOString()]);
  await execute("INSERT INTO videos(id,user_id,title,file,status,transcript,description,uploaded_at,error_message,source_type,source_url,youtube_video_id) VALUES (1,'owner','Video','file.mp4','processing','','','2026-11-13T00:00:00Z','','uploaded','','')");
  const env={DEPLOYMENT_EDITION:"cloud",DB:f.database} as Bindings;
  return {ai:{reserve:userId=>reserveAiAnswerUsage(env,userId),release:reservation=>releaseAiAnswerReservation(env,reservation)},processing:createD1ProcessingQuotaRepository(f.database),execute,
    usage:async()=>{return (await f.database.prepare('SELECT used_ai_answers AS answers,used_processing_seconds AS processing,used_upload_bytes AS uploads FROM users').first<{answers:number;processing:number;uploads:number}>())!;},dispose:f.dispose};
});
