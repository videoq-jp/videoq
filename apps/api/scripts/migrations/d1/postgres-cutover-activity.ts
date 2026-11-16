import type pg from 'pg';
import {z} from 'zod';
const count=z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const countsSchema=z.object({jobLeasesActive:count,jobLeasesExpired:count,jobLeasesInvalid:count,chatLeasesActive:count,chatLeasesExpired:count,chatLeasesInvalid:count,answerAttemptsStarted:count,videosProcessing:count,transcriptionRunsIncomplete:count,visualRunsProcessing:count}).strict();
export const postgresCutoverActivitySchema=z.object({version:z.literal(1),databaseName:z.string().min(1),observedAt:z.string().datetime(),readOnly:z.literal(true),snapshotScope:z.literal('single-read-only-statement'),counts:countsSchema,activeLeasesObserved:z.boolean(),requiresReconciliation:z.boolean(),inFlightDrainProven:z.literal(false)}).strict();
export type PostgresCutoverActivity=z.infer<typeof postgresCutoverActivitySchema>;
const expressions={
 jobLeasesActive:"FROM public.job_executions WHERE status='running' AND lease_token IS NOT NULL AND lease_until>(SELECT at FROM instant)",
 jobLeasesExpired:"FROM public.job_executions WHERE status='running' AND lease_token IS NOT NULL AND lease_until<=(SELECT at FROM instant)",
 jobLeasesInvalid:"FROM public.job_executions WHERE (status='running' AND (lease_token IS NULL OR lease_until IS NULL)) OR (status<>'running' AND (lease_token IS NOT NULL OR lease_until IS NOT NULL))",
 chatLeasesActive:"FROM public.chat_conversations WHERE lease_id IS NOT NULL AND leased_until>(SELECT at FROM instant)",
 chatLeasesExpired:"FROM public.chat_conversations WHERE lease_id IS NOT NULL AND leased_until<=(SELECT at FROM instant)",
 chatLeasesInvalid:"FROM public.chat_conversations WHERE (lease_id IS NULL)<>(leased_until IS NULL)",
 answerAttemptsStarted:"FROM public.ai_answer_attempts WHERE status='started'",
 videosProcessing:"FROM public.videos WHERE status IN ('processing','indexing')",
 transcriptionRunsIncomplete:'FROM public.video_transcription_runs WHERE completed_at IS NULL',
 visualRunsProcessing:"FROM public.video_visual_runs WHERE status='processing'",
} satisfies Record<keyof z.infer<typeof countsSchema>,string>;
const active=(c:z.infer<typeof countsSchema>)=>c.jobLeasesActive>0||c.chatLeasesActive>0;
const reconcile=(c:z.infer<typeof countsSchema>)=>c.jobLeasesExpired>0||c.jobLeasesInvalid>0||c.chatLeasesExpired>0||c.chatLeasesInvalid>0||c.answerAttemptsStarted>0;
/** The caller owns a dedicated READ ONLY transaction. This reports one MVCC
 * statement snapshot; it neither stops writers nor changes expired records. */
export async function readPostgresCutoverActivity(client:pg.Client):Promise<PostgresCutoverActivity>{
 const row=(await client.query<Record<string,unknown>>(`WITH instant AS MATERIALIZED (SELECT clock_timestamp() AS at)
 SELECT current_database() AS database_name,(SELECT at FROM instant) AS observed_at,
 current_setting('transaction_read_only')='on' AS read_only,current_setting('transaction_isolation')='read committed' AS fresh_snapshot,
 ${Object.entries(expressions).map(([name,expression])=>'(SELECT count(*)::text '+expression+') AS "'+name+'"').join(',\n')}`)).rows[0];
 if(row?.read_only!==true||row.fresh_snapshot!==true||typeof row.database_name!=='string'||!(row.observed_at instanceof Date))throw Error('Read-only PostgreSQL activity snapshot required.');
 const counts=countsSchema.parse(Object.fromEntries(Object.keys(expressions).map(name=>{const value=row[name];if(typeof value!=='string'||! /^(0|[1-9][0-9]*)$/.test(value))throw Error('Invalid PostgreSQL activity count.');return[name,Number(value)];})));
 return postgresCutoverActivitySchema.parse({version:1,databaseName:row.database_name,observedAt:row.observed_at.toISOString(),readOnly:true,snapshotScope:'single-read-only-statement',counts,activeLeasesObserved:active(counts),requiresReconciliation:reconcile(counts),inFlightDrainProven:false});
}
/** Absence of live leases is one prerequisite, never a global drain proof.
 * Expired leases and unfinished answer attempts still require reconciliation. */
export function validatePostgresCutoverActivity(value:unknown):PostgresCutoverActivity{
 const report=postgresCutoverActivitySchema.parse(value),c=report.counts;
 if(report.activeLeasesObserved!==active(c)||report.requiresReconciliation!==reconcile(c))throw Error('Inconsistent PostgreSQL activity report.');
 return report;
}
export function assertNoActivePostgresLeases(value:unknown):void{
 const report=validatePostgresCutoverActivity(value),c=report.counts;
 if(active(c)||c.jobLeasesInvalid>0||c.chatLeasesInvalid>0)throw Error('Active or malformed PostgreSQL execution leases remain.');
}
