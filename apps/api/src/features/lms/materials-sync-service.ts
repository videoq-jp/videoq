import type { MaterialsSyncDependencies, MaterialsExportStatus } from './materials-sync-ports';
import { MaterialsLeaseLostError } from '../../persistence/contracts/materials-sync-repository';
import type { LmsResource } from '../../persistence/contracts/lms-resource-repository';
import { lmsResourceStatus } from './resource-service';

/** Bounded JSON orchestration. Media is uploaded by the platform's background task. */
export async function synchronizeMaterials(deps: MaterialsSyncDependencies, installationId: string, contextId: string) {
  if(!deps.enabled)throw new Error('LTI materials connection unavailable');
  const teacher=await deps.teacher(installationId,contextId);
  if(teacher?.resourceLinkId)return {busy:false,pending:false,linked:true};
  if(!teacher)return {busy:false,pending:false,unconnected:true};
  const repository=await deps.repository();
  const leaseId=await deps.stateKey('lti-materials-lease:',installationId,contextId);
  const claimed=await repository.claimContext(installationId,leaseId,deps.newId());
  if(claimed.status==='unavailable')throw new Error('LTI materials connection unavailable');
  if(claimed.status==='busy')return {busy:true,pending:true};
  const {connection:installation,lease}=claimed;
  const assertOwned=async()=>{if(!await repository.owns(lease))throw new MaterialsLeaseLostError();};
  try {
    const client = deps.client(installation);
    const snapshot = await client.manifest(contextId);
    await assertOwned();
    let exports = 0, pending = false;
    for (const source of snapshot.resources) {
      // Every explicit tombstone is reconciled, even when the export batch is full.
      let reconciled: LmsResource;
      try {
        await assertOwned();
        reconciled = await deps.syncResource( {id:installation.id,ownerUserId:teacher.ownerUserId,materialsLease:{id:lease.id,token:lease.token}}, source.externalId, source.manifest);
      } catch (error) {
        if (!deps.youtubeDisabled(error)) throw error;
        // A deployment without native YouTube imports must still reconcile
        // other sources and explicit tombstones in this course.
        await assertOwned();
        await client.acknowledge(contextId, source.externalId, source.manifest.generation, 'blocked', 'YOUTUBE_DISABLED');
        continue;
      }
      const data = await deps.resource({id:installation.id,ownerUserId:teacher.ownerUserId}, source.externalId);
      if(!data || data.resource.generation!==reconciled.generation || data.resource.videoId!==reconciled.videoId)continue;
      await assertOwned();
      if (source.manifest.kind || !source.manifest.enabled || data?.video?.status !== "uploading") {
        await client.acknowledge(contextId, source.externalId, source.manifest.generation,
          lmsResourceStatus({ enabled: source.manifest.enabled, syncError: data.resource.syncError,
            kind: data.resource.kind, videoStatus: data.video?.status }), data.resource.syncError ?? null);
        continue;
      }
      pending = true;
      if (exports >= 5) continue;
      exports++;
      const generation = source.manifest.generation;
      const stateKey = await deps.stateKey("lti-export:", installationId, source.externalId, generation);
      const state=await repository.prepareExport(lease,stateKey,contextId,deps.newId());
      let status: MaterialsExportStatus;
      if (typeof state.jobId === "string") status = await client.exportStatus(contextId, state.jobId, generation);
      else {
        const attempt=state.attempt;
        const url = await deps.uploadUrl( data.video.file, source.manifest.file!.contentType, source.manifest.file!.size);
        await assertOwned();
        status = await client.startExport(contextId, source.externalId, generation, url, attempt);
        const jobId = status.jobId;
        if(!await repository.saveExportJob(lease,stateKey,attempt,jobId))throw new MaterialsLeaseLostError();
      }
      await assertOwned();
      if (status.status === "failed" || status.status === "stale") {
        if(!await repository.deleteExport(lease,stateKey,state.attempt))throw new MaterialsLeaseLostError();
        continue;
      }
      if (status.status !== "uploaded") continue;
      if (status.bytes !== source.manifest.file!.size) throw new Error("Invalid LTI export byte count");
      const current = await deps.resource({id:installation.id,ownerUserId:teacher.ownerUserId}, source.externalId);
      if (!current?.resource.enabled || current.resource.generation !== reconciled.generation || current.video?.id !== data.video.id) continue;
      // Storage I/O may outlive the lease. Fence the actual DB transition and
      // durable job against both the current lease and resource generation.
      const actualBytes=await deps.objectSize(data.video.file);
      if(actualBytes!==source.manifest.file!.size)throw new Error("LTI export object size mismatch");
      const confirmed=await repository.confirmUpload(lease,{externalId:source.externalId,generation,videoId:data.video.id,fileKey:data.video.file});
      if(!confirmed)throw new MaterialsLeaseLostError();
      await deps.processTask(confirmed.taskId);
    }
    await assertOwned();
    await deps.scheduleRecovery();
    return { busy: false, pending };
  } finally {
    await repository.release(lease);
  }
}

/** Poll enrolled platforms without requiring a learner to open a video first. */
export async function sweepMaterials(deps: MaterialsSyncDependencies) {
  if (!deps.enabled) return { synchronized: 0 };
  const repository=await deps.repository(),claimed=await repository.claimNext(deps.newId());
  if(!claimed)return {synchronized:0};
  const {connection,lease}=claimed;
  try{
    const client=deps.client(connection);
    const contexts=[...new Set(await client.courses())].sort();
    if(!await repository.owns(lease))throw new MaterialsLeaseLostError();
    if(!contexts.length)return {synchronized:0};
    const cursor=connection.materialsCursor%contexts.length;
    await synchronizeMaterials(deps,connection.id,contexts[cursor]);
    const finished=await repository.finishPoll(lease,(cursor+1)%contexts.length,contexts.length>1?10:30);
    return {synchronized:finished?1:0};
  }finally{await repository.release(lease);}
}
