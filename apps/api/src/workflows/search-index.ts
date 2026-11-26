import { logJobFailure } from '../integrations/background-jobs/diagnostics';
import { SafeJobError, classifyJobFailure, JOB_FAILURE_CODES, safeJobFailureCode } from '../application/job-failure';
import { streamingOtsuBoundary } from '../application/streaming-otsu';
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep, type WorkflowStepConfig } from 'cloudflare:workers';
import { canonicalBackgroundJob, parseBackgroundJob } from '../application/background-job';
import { parseSearchScenes } from '../application/search-scene-splitting';
import type { SceneIndexSource } from '../application/scene-index-policy';
import { createJobRepository, createWorkerScenePersistence } from '../persistence/factory';
import { embedTexts } from '../lib/embeddings';
import { embeddingFingerprint, embeddingDimensions, resolveEmbeddingConfig } from '../lib/embedding-contract';
import { splitTranscriptForIndex } from '../integrations/search-index/scene-splitter';
import { runBackgroundJob, sha256 } from '../integrations/background-jobs/execute';
import { armMaintenance } from '../lib/task-scheduler';
import type { Bindings } from '../types/bindings';

const retry = { retries: { limit: 8, delay: '10 seconds', backoff: 'exponential' }, timeout: '10 minutes' } as const;

/** Large subtitles and vectors stay in R2; durable step results contain references only. */
export class SearchIndexWorkflow extends WorkflowEntrypoint<Bindings, unknown> {
  async run(event: WorkflowEvent<unknown>, step: WorkflowStep) {
    const started=performance.now();
    try { return await this.execute(event, step); }
    catch (error) {
      let job;
      try { job=parseBackgroundJob(event.payload); } catch { /* No payload data is logged. */ }
      logJobFailure(error,{event:'background_workflow_failed',stage:job?'execute':'validate',started,workflow_id:event.instanceId,job_id:job?.job_id,job_type:job?.type});
      const failures = this.env.SEARCH_FAILURES;
      if (failures) await step.do('dead-letter-workflow', retry, async () => {
        await failures.send({ workflowId: event.instanceId, message: event.payload, errorCode: 'SEARCH_WORKFLOW_FAILED' });
      });
      throw error;
    }
  }
  private async execute(event: WorkflowEvent<unknown>, step: WorkflowStep) {
    // Workflows serializes thrown errors across RPC and drops custom fields.
    // Encode only an allowlisted cause in the error name before that boundary.
    const durable = async <T extends Rpc.Serializable<T>>(name: string, config: WorkflowStepConfig, operation: () => Promise<T>): Promise<T> => {
      try {
        return await step.do(name, config, async () => {
          try { return await operation(); }
          catch (error) {
            if (error instanceof SafeJobError) throw error;
            const failure = classifyJobFailure(error);
            throw new SafeJobError(failure.error_code, failure.retryable);
          }
        });
      } catch (error) {
        if (error instanceof SafeJobError) throw error;
        // Decode only here, after our callback has converted arbitrary source /
        // provider exceptions. The shared classifier never trusts text markers.
        if (error instanceof Error) {
          const marker = /^SafeJobError_([A-Z_]{1,64}): /.exec(error.message.slice(0,96));
          if (marker && (JOB_FAILURE_CODES as readonly string[]).includes(marker[1])) {
            const code = safeJobFailureCode(marker[1]);
            throw new SafeJobError(code,!['INVALID_JOB','INVALID_TRANSCRIPT','JOB_IDENTITY_CONFLICT'].includes(code));
          }
        }
        throw error;
      }
    };
    // Reads outside model steps may exceed the step-result byte limit. Retry
    // transient R2/D1 reads with durable sleeps without checkpointing their data.
    const io = async <T>(name: string, operation: () => Promise<T>): Promise<T> => {
      for (let attempt = 0; ; attempt++) {
        try { return await operation(); }
        catch (error) {
          if (attempt === 4) throw error;
          await step.sleep(`${name}-retry-${attempt}`, '5 seconds');
        }
      }
    };
    const job = parseBackgroundJob(event.payload);
    if (job.type === 'delete_account_data') throw new Error('Account job is not a search workflow');
    if (job.type === 'reindex_all_videos_embeddings') {
      await durable('dispatch-reindex-page', retry, () => runBackgroundJob(this.env, job));
      return;
    }
    const bucket = this.env.VIDEO_BUCKET;
    if (!bucket) throw new Error('Search workflow requires R2');
    const config = resolveEmbeddingConfig(this.env);
    const fingerprint = await embeddingFingerprint(config);
    const dimensions = embeddingDimensions(config) as 768 | 1536;
    const repository = await createJobRepository(this.env);
    const root = `internal/search-index/${await sha256(job.job_id)}/`;
    const cleanup = async () => {
      let cursor: string | undefined;
      do {
        const page = await bucket.list({ prefix: root, cursor });
        if (page.objects.length) await bucket.delete(page.objects.map(object => object.key));
        cursor = page.truncated ? page.cursor : undefined;
      } while (cursor);
    };
    const identity = { jobId: job.job_id, jobType: job.type, payloadSha256: await sha256(canonicalBackgroundJob(job)) };
    if (!this.env.DB) throw new Error('Search workflow requires D1');
    const database = this.env.DB;
    const alreadyComplete = await io('read-job-state', () => database.prepare("SELECT job_id FROM job_executions WHERE job_id=? AND job_type=? AND payload_sha256=? AND status='completed'")
      .bind(identity.jobId, identity.jobType, identity.payloadSha256).first());
    if (alreadyComplete) {
      await durable('completed-job-cleanup', retry, cleanup);
      return;
    }
    const claim = await durable('claim-job', retry, async () => {
      const result = await repository.claim(identity);
      if (result.status === 'busy' || result.status === 'conflict') throw new Error(`Search job ${result.status}`);
      return result;
    });
    if (claim.status === 'completed') { await durable('completed-job-cleanup', retry, cleanup); return; }
    if (claim.status !== 'claimed') throw new Error('Invalid search job claim');
    let leaseToken = claim.leaseToken;
    const renew = async () => {
      if (await repository.heartbeat(job.job_id, leaseToken)) return;
      const current = await repository.claim(identity);
      if (current.status !== 'claimed') throw new Error(`Search job lease ${current.status}`);
      leaseToken = current.leaseToken;
    };
    const persistence = await createWorkerScenePersistence(this.env);
    const key = `${root}prepared.json`;
    const sourceKey = `${root}source.json`;
    const finish = (source: SceneIndexSource) => persistence.finish({ ...source, dimensions });
    try {
      const snapshot = await durable('load-source', retry, async () => {
        await renew();
        const source = await persistence.readSource(job.payload.video_id);
        if (!source) return null;
        if (job.type === 'index_video_transcript') {
          if (source.status === 'completed') return null;
          if (source.status !== 'indexing') throw new SafeJobError('INDEX_NOT_READY', true, 'Video is not ready for indexing');
          const status = await finish(source);
          if (status === 'completed') return null;
          // Published runs already own durable delivery tasks. Their final
          // readiness acknowledgement atomically queues a completion job; do
          // not spend workflow retries or regenerate embeddings while waiting.
          if (status === 'pending') {
            if (this.env.TASK_SCHEDULER) await armMaintenance(this.env, Date.now() + 1000);
            return null;
          }
          if (status !== 'missing') throw new SafeJobError('INDEX_SOURCE_CHANGED', true, 'Scene source changed before indexing completion');
          if (!source.transcript.trim() && !job.payload.allow_empty) throw new SafeJobError('INVALID_TRANSCRIPT', false, 'Video has no transcript');
        }
        if (source.transcript.trim() && !parseSearchScenes(source.transcript).length) throw new SafeJobError('INVALID_TRANSCRIPT', false, 'Invalid SRT source');
        const runId = crypto.randomUUID();
        await bucket.put(sourceKey, JSON.stringify({fingerprint,source}), { httpMetadata: { contentType: 'application/json' } });
        return { fingerprint, runId, source: { ...source, transcript: '' }, model: config.model, profile: config.profile ?? 'openai', dimensions };
      });
      if (snapshot && (snapshot.fingerprint !== fingerprint || snapshot.model !== config.model || snapshot.profile !== (config.profile ?? 'openai') || snapshot.dimensions !== dimensions)) {
        throw new Error('Embedding configuration changed during workflow');
      }
      let prepared: (NonNullable<typeof snapshot> & { count: number }) | null = null;
      if (snapshot) {
        const savedManifest = await io('read-prepared-scenes', async () => {
          const saved = await bucket.get(key);
          return saved ? saved.json<{ runId: string; sourceRevision: string; fingerprint: string; model: string; dimensions: number; scenes: ReturnType<typeof parseSearchScenes> }>() : null;
        });
        let scenes: ReturnType<typeof parseSearchScenes>;
        if (savedManifest?.fingerprint === fingerprint && savedManifest.runId === snapshot.runId && savedManifest.sourceRevision === snapshot.source.sourceRevision && savedManifest.model === config.model && savedManifest.dimensions === dimensions) scenes = savedManifest.scenes;
        else {
          const source = await io('read-source', async () => {
            const object = await bucket.get(sourceKey);
            if (!object) throw new Error('Source snapshot is missing');
            const saved = await object.json<{fingerprint:string;source:SceneIndexSource}>();
            if (saved.fingerprint !== fingerprint || !saved.source) throw new Error('Embedding source artifact identity changed');
            return saved.source;
          });
          let artifactsReady = false;
          const grouped = source.transcript.trim() ? await splitTranscriptForIndex(this.env, source.transcript, undefined,
            () => Promise.reject(new Error('Use streaming scene boundaries')),
            async (start, end, texts) => {
              if (!artifactsReady) {
                for (let offset = 0; offset < texts.length; offset += 16) {
                  const artifact = `${root}${snapshot.runId}-split-${offset}.json`;
                  await durable(`split-embeddings-${offset}`, retry, async () => {
                    await renew();
                    if (!await bucket.head(artifact)) {
                      const values = await embedTexts(this.env, texts.slice(offset, offset + 16), 'document');
                      await bucket.put(artifact, JSON.stringify(values), { httpMetadata: { contentType: 'application/json' } });
                    }
                  });
                }
                artifactsReady = true;
              }
              return streamingOtsuBoundary(start, end, {
                dimensions, batchSize: 16, batchesPerStep: 64,
                readBatch: async offset => {
                  const object = await bucket.get(`${root}${snapshot.runId}-split-${offset}.json`);
                  if (!object) throw new Error('Scene splitting embeddings are missing');
                  return object.json<number[][]>();
                },
                checkpoint: (name, operation) => durable(name, retry, async () => { await renew(); return operation(); }),
              });
            }) : '';
          scenes = parseSearchScenes(grouped);
          if (source.transcript.trim() && !scenes.length) throw new SafeJobError('INVALID_TRANSCRIPT', false, 'Scene splitting produced no scenes');
        }
        prepared = await durable('prepare-scenes', retry, async () => {
          await renew();
          await bucket.put(key, JSON.stringify({ runId: snapshot.runId, sourceRevision: snapshot.source.sourceRevision, fingerprint, model: config.model, dimensions, scenes }), { httpMetadata: { contentType: 'application/json' } });
          return { ...snapshot, count: scenes.length };
        });
      }
      if (prepared) {
        if (prepared.fingerprint !== fingerprint || prepared.model !== config.model || prepared.profile !== (config.profile ?? 'openai') || prepared.dimensions !== dimensions) throw new Error('Embedding configuration changed during workflow');
        await durable('start-scene-run', retry, async () => {
          await renew();
          if (this.env.TASK_SCHEDULER) await armMaintenance(this.env, Date.now() + 1000);
          if (!await persistence.writer.start({ runId: prepared.runId, videoId: prepared.source.videoId, userId: prepared.source.userId, sourceRevision: prepared.source.sourceRevision, embeddingFingerprint: fingerprint, dimensions, expectedScenes: prepared.count })) throw new SafeJobError('INDEX_SOURCE_CHANGED', true, 'Scene source changed');
        });
        for (let offset = 0; offset < prepared.count; offset += 20) {
          await durable(`embed-stage-${offset}`, retry, async () => {
            await renew();
            const artifact = `${root}${prepared.runId}-${offset}.json`;
            const existing = await bucket.get(artifact);
            let rows: import('../application/scene-index-policy').SceneEmbedding[];
            if (existing) rows = await existing.json();
            else {
              const document = await bucket.get(key);
              if (!document) throw new Error('Prepared scenes are missing');
              const data = await document.json<{ scenes: ReturnType<typeof parseSearchScenes> }>();
              const chunk = data.scenes.slice(offset, offset + 20);
              const vectors = await embedTexts(this.env, chunk.map(s => s.text), 'document');
              rows = chunk.map((scene, i) => ({ id: `${prepared.runId}:${offset + i}`, content: scene.text, startTime: scene.startTime, endTime: scene.endTime, embedding: vectors[i] }));
              // Persist exact vectors before stage: replays cannot regenerate a
              // different immutable vector version after a lost acknowledgement.
              await bucket.put(artifact, JSON.stringify(rows), { httpMetadata: { contentType: 'application/json' } });
            }
            if (!await persistence.writer.stage(prepared.runId, prepared.source.userId, rows)) throw new SafeJobError('INDEX_SOURCE_CHANGED', true, 'Scene source changed during indexing');
          });
        }
        await durable('publish-scene-run', retry, async () => {
          await renew();
          if (!await persistence.writer.publish(prepared.runId, prepared.source.userId)) throw new SafeJobError('INDEX_SOURCE_CHANGED', true, 'Scene source changed before publication');
          if (this.env.TASK_SCHEDULER) await armMaintenance(this.env, Date.now() + 1000);
        });
        if (job.type === 'index_video_transcript') {
          await durable('finish-video-indexing', retry, async () => {
            await renew();
            const status = await finish(prepared.source);
            if (status === 'pending') {
              if (this.env.TASK_SCHEDULER) await armMaintenance(this.env, Date.now() + 1000);
            } else if (status !== 'completed') {
              // Deletion can follow vector readiness before this durable step
              // wakes up. A removed source has no remaining indexing work;
              // existing sources must still pass the revision/readiness fence.
              if (await persistence.readSource(prepared.source.videoId) !== null) {
                throw new SafeJobError('INDEX_SOURCE_CHANGED', true, 'Scene source changed before indexing completion');
              }
            }
          });
        }
      }
      await durable('complete-job', retry, async () => {
        if (!await repository.heartbeat(job.job_id, leaseToken)) {
          const current = await repository.claim(identity);
          // Completion may have committed before the step acknowledgement.
          if (current.status === 'completed') return;
          if (current.status !== 'claimed') throw new Error(`Search job lease ${current.status}`);
          leaseToken = current.leaseToken;
        }
        if (!await repository.complete(job.job_id, leaseToken)) throw new Error('Search job lease was lost');
      });
      await durable('remove-workflow-artifacts', retry, cleanup);
    } catch (error) {
      await repository.fail(job.job_id, leaseToken, classifyJobFailure(error).error_code).catch(() => false);
      throw error;
    }
  }
}
