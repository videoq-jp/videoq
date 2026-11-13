import {teachingConnection} from '../teaching/service';
import { materialStateKey } from '../lms/material-state-key';
import { ltiMaterialsEnabled } from "./config";
import { armMaintenance } from "../../lib/task-scheduler";
import {createMaterialsSyncRepository} from '../../persistence/factory';
import {MaterialsLeaseLostError} from '../../persistence/contracts/materials-sync-repository';
import { getLmsResource, syncLmsResource } from "../../repositories/lms-resource-repository";
import { getR2ObjectSize, presignR2Put } from "../../integrations/media";
import {processExternalTaskById} from "../../lib/external-tasks";
import type { Bindings } from "../../types/bindings";
import { MaterialsClient } from "./materials-client";
import { LmsSyncError } from '../lms/resource';

/** Bounded JSON orchestration. Media is uploaded by the platform's background task. */
export async function synchronizeMaterials(env: Bindings, installationId: string, contextId: string) {
  if(!ltiMaterialsEnabled(env))throw new Error('LTI materials connection unavailable');
  const teacher=await teachingConnection(env,'moodle',installationId,contextId);
  if(teacher?.resourceLinkId)return {busy:false,pending:false,linked:true};
  if(!teacher)return {busy:false,pending:false,unconnected:true};
  const repository=await createMaterialsSyncRepository(env);
  const leaseId=await materialStateKey('lti-materials-lease:',installationId,contextId);
  const claimed=await repository.claimContext(installationId,leaseId,crypto.randomUUID());
  if(claimed.status==='unavailable')throw new Error('LTI materials connection unavailable');
  if(claimed.status==='busy')return {busy:true,pending:true};
  const {connection:installation,lease}=claimed;
  const assertOwned=async()=>{if(!await repository.owns(lease))throw new MaterialsLeaseLostError();};
  try {
    const client = new MaterialsClient(env, { ...installation, materialsService: installation.materialsService });
    const snapshot = await client.manifest(contextId);
    await assertOwned();
    let exports = 0, pending = false;
    for (const source of snapshot.resources) {
      // Every explicit tombstone is reconciled, even when the export batch is full.
      let reconciled: Awaited<ReturnType<typeof syncLmsResource>>;
      try {
        await assertOwned();
        reconciled = await syncLmsResource(env, {id:installation.id,ownerUserId:teacher.ownerUserId,materialsLease:{id:lease.id,token:lease.token}}, source.externalId, source.manifest);
      } catch (error) {
        if (!(error instanceof LmsSyncError) || error.code !== 'YOUTUBE_DISABLED') throw error;
        // A deployment without native YouTube imports must still reconcile
        // other sources and explicit tombstones in this course.
        await assertOwned();
        await client.acknowledge(contextId, source.externalId, source.manifest.generation, 'blocked', 'YOUTUBE_DISABLED');
        continue;
      }
      const data = await getLmsResource(env,{id:installation.id,ownerUserId:teacher.ownerUserId}, source.externalId);
      if(!data || data.resource.generation!==reconciled.generation || data.resource.videoId!==reconciled.videoId)continue;
      await assertOwned();
      if (source.manifest.kind || !source.manifest.enabled || data?.video?.status !== "uploading") {
        await client.acknowledge(contextId, source.externalId, source.manifest.generation,
          !source.manifest.enabled ? "disabled" : data?.resource.syncError ? "blocked" : data?.resource.kind === 'course' ? 'completed' : data?.video?.status ?? "awaiting_upload", data?.resource.syncError ?? null);
        continue;
      }
      pending = true;
      if (exports >= 5) continue;
      exports++;
      const generation = source.manifest.generation;
      const stateKey = await materialStateKey("lti-export:", installationId, source.externalId, generation);
      const state=await repository.prepareExport(lease,stateKey,contextId,crypto.randomUUID());
      let status: Awaited<ReturnType<MaterialsClient["exportStatus"]>>;
      if (typeof state.jobId === "string") status = await client.exportStatus(contextId, state.jobId, generation);
      else {
        const attempt=state.attempt;
        const url = await presignR2Put(env, data.video.file, source.manifest.file!.contentType, source.manifest.file!.size);
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
      const current = await getLmsResource(env,{id:installation.id,ownerUserId:teacher.ownerUserId}, source.externalId);
      if (!current?.resource.enabled || current.resource.generation !== reconciled.generation || current.video?.id !== data.video.id) continue;
      // Storage I/O may outlive the lease. Fence the actual DB transition and
      // durable job against both the current lease and resource generation.
      const actualBytes=await getR2ObjectSize(env,data.video.file);
      if(actualBytes!==source.manifest.file!.size)throw new Error("LTI export object size mismatch");
      const confirmed=await repository.confirmUpload(lease,{externalId:source.externalId,generation,videoId:data.video.id,fileKey:data.video.file});
      if(!confirmed)throw new MaterialsLeaseLostError();
      await processExternalTaskById(env,confirmed.taskId);
    }
    await assertOwned();
    await armMaintenance(env, Date.now());
    return { busy: false, pending };
  } finally {
    await repository.release(lease);
  }
}

/** Poll enrolled platforms without requiring a learner to open a video first. */
export async function sweepMaterials(env: Bindings) {
  if (!ltiMaterialsEnabled(env)) return { synchronized: 0 };
  const repository=await createMaterialsSyncRepository(env),claimed=await repository.claimNext(crypto.randomUUID());
  if(!claimed)return {synchronized:0};
  const {connection,lease}=claimed;
  try{
    const client=new MaterialsClient(env,connection);
    const contexts=[...new Set(await client.courses())].sort();
    if(!await repository.owns(lease))throw new MaterialsLeaseLostError();
    if(!contexts.length)return {synchronized:0};
    const cursor=connection.materialsCursor%contexts.length;
    await synchronizeMaterials(env,connection.id,contexts[cursor]);
    const finished=await repository.finishPoll(lease,(cursor+1)%contexts.length,contexts.length>1?10:30);
    return {synchronized:finished?1:0};
  }finally{await repository.release(lease);}
}
