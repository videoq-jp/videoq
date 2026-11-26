import { embeddingFingerprint, resolveEmbeddingConfig } from '../../lib/embedding-contract';
import { canonicalBackgroundJob, parseBackgroundJob, type BackgroundJob } from '../../application/background-job';
import type { SceneIndexSource } from '../../application/scene-index-policy';
import { createJobRepository, createWorkerScenePersistence } from '../../persistence/factory';
import type { Bindings } from '../../types/bindings';

async function hash(value: string): Promise<string> {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))), b => b.toString(16).padStart(2, '0')).join('');
}
function requireSearch(input: unknown): BackgroundJob {
  const job = parseBackgroundJob(input);
  if (job.type === 'delete_account_data') throw new Error('RECOVERY_SEARCH_ONLY');
  return job;
}
async function inspect(env: Bindings, job: BackgroundJob, reserved = false, target = 'local') {
  if (!env.DB || !env.VIDEO_BUCKET || !env.SEARCH_INDEX_WORKFLOW) throw new Error('RECOVERY_BINDINGS_REQUIRED');
  const fingerprint = await embeddingFingerprint(resolveEmbeddingConfig(env));
  const payloadHash = await hash(canonicalBackgroundJob(job));
  const workflowId = await hash(`${job.job_id}\n${canonicalBackgroundJob(job)}`);
  const status = (await (await env.SEARCH_INDEX_WORKFLOW.get(workflowId)).status()).status;
  if (status !== 'errored' && status !== 'terminated') throw new Error('RECOVERY_TERMINAL_WORKFLOW_REQUIRED');
  const ledger = await env.DB.prepare('SELECT job_type,payload_sha256,status,attempts,lease_until FROM job_executions WHERE job_id=?').bind(job.job_id)
    .first<{job_type:string;payload_sha256:string;status:string;attempts:number;lease_until:string|null}>();
  if (ledger && (ledger.job_type !== job.type || ledger.payload_sha256 !== payloadHash)) throw new Error('RECOVERY_IDENTITY_CONFLICT');
  if (ledger?.status === 'completed') throw new Error('RECOVERY_JOB_COMPLETED');
  if (!reserved && ledger?.status === 'running' && (!ledger.lease_until || Date.parse(ledger.lease_until) > Date.now())) throw new Error('RECOVERY_JOB_BUSY');
  const prefix = `internal/search-index/${await hash(job.job_id)}/`;
  const artifacts: { key_hash:string; content_hash:string }[] = [];
  let cursor: string | undefined;
  do {
    const page = await env.VIDEO_BUCKET.list({ prefix, cursor });
    for (const item of page.objects) {
      const object = await env.VIDEO_BUCKET.get(item.key);
      if (!object) throw new Error('RECOVERY_ARTIFACT_CHANGED');
      artifacts.push({ key_hash: await hash(item.key), content_hash: await hash(await object.text()) });
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  artifacts.sort((a,b) => a.key_hash.localeCompare(b.key_hash));
  let sourceHash: string | null = null;
  if (job.type === 'index_video_transcript' || job.type === 'reindex_video_transcript') {
    const source = await (await createWorkerScenePersistence(env)).readSource(job.payload.video_id);
    if (!source) throw new Error('RECOVERY_SOURCE_MISSING');
    sourceHash = await hash(JSON.stringify(source));
    const saved = await env.VIDEO_BUCKET.get(`${prefix}source.json`);
    if (saved) {
      let envelope: {fingerprint:string;source:SceneIndexSource};
      try { envelope = await saved.json<{fingerprint:string;source:SceneIndexSource}>(); } catch { throw new Error('RECOVERY_INVALID_ARTIFACT'); }
      if (envelope.fingerprint !== fingerprint || !envelope.source) throw new Error('RECOVERY_ARTIFACT_IDENTITY_MISMATCH');
      const snapshot = envelope.source;
      if (snapshot.videoId !== source.videoId || snapshot.userId !== source.userId || snapshot.sourceRevision !== source.sourceRevision ||
          snapshot.fileKey !== source.fileKey || snapshot.transcript !== source.transcript) throw new Error('RECOVERY_SOURCE_CHANGED');
    }
  }
  const prepared = await env.VIDEO_BUCKET.get(`${prefix}prepared.json`);
  if (prepared) {
    let manifest: {fingerprint?:string};
    try { manifest = await prepared.json(); } catch { throw new Error('RECOVERY_INVALID_ARTIFACT'); }
    if (manifest?.fingerprint !== fingerprint) throw new Error('RECOVERY_ARTIFACT_IDENTITY_MISMATCH');
  }
  const evidence = { target, fingerprint, workflowId, status, payloadHash, sourceHash, artifacts };
  return { evidence, ledger, digest: await hash(JSON.stringify({ evidence, ledger })) };
}
/** Read-only, content-free report. Retain this digest for the explicit restart. */
export async function inspectSearchWorkflowRecovery(env: Bindings, input: unknown, target = 'local') {
  const state = await inspect(env, requireSearch(input), false, target);
  return { inspection: state.digest, ...state.evidence, ledger: state.ledger };
}
/** Restart clears durable steps. Old R2 artifacts remain for audit; new run IDs
 * and source/publication fences prevent their reuse as a different execution. */
export async function recoverSearchWorkflow(env: Bindings, input: unknown, expectedInspection: string, target = 'local', actorId = 'local') {
  const job = requireSearch(input);
  const before = await inspect(env, job, false, target);
  if (!/^[a-f0-9]{64}$/.test(expectedInspection) || before.digest !== expectedInspection) throw new Error('RECOVERY_INSPECTION_CHANGED');
  const repository = await createJobRepository(env);
  const claim = await repository.claim({ jobId:job.job_id,jobType:job.type,payloadSha256:before.evidence.payloadHash });
  if (claim.status !== 'claimed') throw new Error('RECOVERY_JOB_BUSY');
  const auditId = crypto.randomUUID();
  const auditKey = `internal/search-recovery/${auditId}.json`;
  try {
    // Read under our lease without treating our own reservation as a conflict.
    const ledger = await env.DB!.prepare('SELECT lease_token FROM job_executions WHERE job_id=? AND status=\'running\'').bind(job.job_id).first<{lease_token:string}>();
    if (ledger?.lease_token !== claim.leaseToken) throw new Error('RECOVERY_LEASE_LOST');
    const checked = await inspect(env,job,true,target);
    if (JSON.stringify(checked.evidence) !== JSON.stringify(before.evidence)) throw new Error('RECOVERY_STATE_CHANGED');
    const instance = await env.SEARCH_INDEX_WORKFLOW!.get(before.evidence.workflowId);
    const current = (await instance.status()).status;
    if (current !== before.evidence.status || !await repository.heartbeat(job.job_id,claim.leaseToken)) throw new Error('RECOVERY_STATE_CHANGED');
    const audit = { auditId, actorHash:await hash(actorId), inspection:before.digest, evidence:before.evidence, ledger:before.ledger, requestedAt:new Date().toISOString() };
    await env.VIDEO_BUCKET!.put(auditKey,JSON.stringify({ ...audit, outcome:'restart_requested' }));
    await instance.restart();
    await env.VIDEO_BUCKET!.put(auditKey,JSON.stringify({ ...audit, outcome:'restart_accepted', acceptedAt:new Date().toISOString() }));
    return { auditId, workflowId:before.evidence.workflowId, inspection:before.digest, outcome:'restart_accepted' as const };
  } finally {
    // The restarted Workflow retries a busy claim until this fenced reservation
    // is released; a killed administrator process expires after the normal lease.
    const released = await repository.fail(job.job_id,claim.leaseToken,'RECOVERY_RESTART_REQUESTED').catch(()=>false);
    if (!released) {
      console.error(JSON.stringify({event:'background_recovery_lease_release_failed',auditId,error_code:'RECOVERY_LEASE_RELEASE_FAILED'}));
      await env.VIDEO_BUCKET!.put(`${auditKey}.release.json`,JSON.stringify({auditId,error_code:'RECOVERY_LEASE_RELEASE_FAILED'})).catch(()=>undefined);
    }
  }
}
