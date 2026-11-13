import type { Bindings } from "../types/bindings";
import type { UserSecretsRepository } from "./contracts/user-secrets";
import { persistenceBackend } from "./backend";

export async function createUserSecretsRepository(env: Bindings): Promise<UserSecretsRepository> {
  if (persistenceBackend(env) === "d1") {
    if (!env.DB) throw new Error("D1 DB binding is required");
    const { createD1UserSecretsRepository } = await import("./d1/user-secrets");
    return createD1UserSecretsRepository(env.DB);
  }
  const { createPostgresUserSecretsRepository } = await import("./postgres/user-secrets");
  return createPostgresUserSecretsRepository(env);
}

export async function createJobRepository(env: Bindings): Promise<import("./contracts/job-repository").JobRepository> {
  if (persistenceBackend(env) === "d1") {
    if (!env.DB) throw new Error("D1 DB binding is required");
    const { createD1JobRepository } = await import("./d1/job-repository");
    return createD1JobRepository(env.DB);
  }
  const { createPostgresJobRepository } = await import("./postgres/job-repository");
  return createPostgresJobRepository(env);
}

export async function createUserRepository(env: Bindings): Promise<import("./contracts/user-repository").UserRepository> {
  if (persistenceBackend(env) === "d1") {
    if (!env.DB) throw new Error("D1 DB binding is required");
    const { createD1UserRepository } = await import("./d1/user-repository");
    return createD1UserRepository(env.DB);
  }
  const [{ getCurrentUser }, { createPostgresUserSecretsRepository }] = await Promise.all([
    import("./postgres/user-repository"), import("./postgres/user-secrets"),
  ]);
  return { ...createPostgresUserSecretsRepository(env), getCurrentUser: userId => getCurrentUser(env, userId) };
}

export async function pingPersistence(env: Bindings): Promise<boolean> {
  if (persistenceBackend(env) === "d1") {
    if (!env.DB) throw new Error("D1 DB binding is required");
    return (await env.DB.prepare("SELECT 1 AS ok").first<number>("ok")) === 1;
  }
  const { pingDb } = await import("../db/pool");
  return pingDb(env);
}

export async function createVideoUploadRepository(env: Bindings): Promise<import("./contracts/video-upload-repository").VideoUploadRepository> {
  if (persistenceBackend(env) === "d1") {
    if (!env.DB) throw new Error("D1 DB binding is required");
    const { createD1VideoUploadRepository } = await import("./d1/video-upload-repository");
    return createD1VideoUploadRepository(env.DB);
  }
  const { createPostgresVideoUploadRepository } = await import("./postgres/video-upload-repository");
  return createPostgresVideoUploadRepository(env);
}

export async function createVideoReadRepository(env: Bindings): Promise<import("./contracts/video-read-repository").VideoReadRepository> {
  if (persistenceBackend(env) === "d1") {
    if (!env.DB) throw new Error("D1 DB binding is required");
    const { createD1VideoReadRepository } = await import("./d1/video-read-repository");
    return createD1VideoReadRepository(env.DB, env);
  }
  const { createPostgresVideoReadRepository } = await import("./postgres/video-read-repository");
  return createPostgresVideoReadRepository(env);
}

export async function createExternalTaskRepository(env: Bindings): Promise<import("./contracts/external-task-repository").ExternalTaskRepository> {
  if (persistenceBackend(env) === "d1") {
    if (!env.DB) throw new Error("D1 DB binding is required");
    const { createD1ExternalTaskRepository } = await import("./d1/external-task-repository");
    return createD1ExternalTaskRepository(env.DB);
  }
  const { createPostgresExternalTaskRepository } = await import("./postgres/external-task-repository");
  return createPostgresExternalTaskRepository(env);
}

export async function createMaintenanceRepository(env: Bindings): Promise<import("./contracts/maintenance-repository").MaintenanceRepository> {
  if (persistenceBackend(env) === "d1") {
    if (!env.DB) throw new Error("D1 DB binding is required");
    const [{ createD1MaintenanceRepository }, { ltiMaterialsEnabled }, embedding] = await Promise.all([
      import("./d1/maintenance-repository"), import("../features/lti/config"), import("../lib/embedding-contract"),
    ]);
    const dimensions = embedding.embeddingDimensions(embedding.resolveEmbeddingConfig(env)) as 768 | 1536;
    return createD1MaintenanceRepository(env.DB, ltiMaterialsEnabled(env), dimensions);
  }
  const { createPostgresMaintenanceRepository } = await import("./postgres/maintenance-repository");
  return createPostgresMaintenanceRepository(env);
}

export async function createMediaRepository(env: Bindings): Promise<import("./contracts/media-repository").MediaRepository> {
  if (persistenceBackend(env) === "d1") {
    if (!env.DB) throw new Error("D1 DB binding is required");
    const { createD1MediaRepository } = await import("./d1/media-repository");
    return createD1MediaRepository(env.DB);
  }
  const { createPostgresMediaRepository } = await import("./postgres/media-repository");
  return createPostgresMediaRepository(env);
}

export async function createVideoEvidenceRepository(env: Bindings): Promise<import("./contracts/video-evidence-repository").VideoEvidenceRepository> {
  if (persistenceBackend(env) === "d1") {
    if (!env.DB) throw new Error("D1 DB binding is required");
    const { createD1VideoEvidenceRepository } = await import("./d1/video-evidence-repository");
    return createD1VideoEvidenceRepository(env.DB);
  }
  const { createPostgresVideoEvidenceRepository } = await import("./postgres/video-evidence-repository");
  return createPostgresVideoEvidenceRepository(env);
}

export async function createTagRepository(env: Bindings): Promise<import("./contracts/tag-repository").TagRepository> {
  if (persistenceBackend(env) === "d1") {
    if (!env.DB) throw new Error("D1 DB binding is required");
    const { createD1TagRepository } = await import("./d1/tag-repository");
    return createD1TagRepository(env.DB, env);
  }
  const { createPostgresTagRepository } = await import("./postgres/tag-repository");
  return createPostgresTagRepository(env);
}

export async function createVideoMutationRepository(env: Bindings): Promise<import("./contracts/video-mutation-repository").VideoMutationRepository> {
  if (persistenceBackend(env) === "d1") {
    if (!env.DB) throw new Error("D1 DB binding is required");
    const { createD1VideoMutationRepository } = await import("./d1/video-mutation-repository");
    const onIndexWork = env.TASK_SCHEDULER ? async () => {
      const { armMaintenance, ARM_FLOOR_MS } = await import("../lib/task-scheduler");
      await armMaintenance(env, Date.now() + ARM_FLOOR_MS);
    } : undefined;
    return createD1VideoMutationRepository(env.DB, onIndexWork);
  }
  const { createPostgresVideoMutationRepository } = await import("./postgres/video-mutation-repository");
  return createPostgresVideoMutationRepository(env);
}

export async function maintainSceneIndex(env: Bindings) {
  if (persistenceBackend(env) !== "d1") return { claimed: 0, completed: 0, failed: 0, leaseLost: 0, reconciled: 0, verified: 0, repairQueued: 0 };
  if (!env.DB) throw new Error("D1 DB binding is required");
  const [{ maintainD1SceneIndex }, embedding] = await Promise.all([
    import("./d1/scene-index-maintenance"), import("../lib/embedding-contract"),
  ]);
  const dimensions = embedding.embeddingDimensions(embedding.resolveEmbeddingConfig(env)) as 768 | 1536;
  return maintainD1SceneIndex(env.DB, { 1536: env.SCENE_VECTORIZE_1536, 768: env.SCENE_VECTORIZE_768 }, dimensions);
}

/** Staged scene ingestion is cloud-only; on-prem workers retain pgvector. */
export async function createWorkerScenePersistence(env: Bindings) {
  if (persistenceBackend(env) !== "d1") throw new Error("Worker scene API requires D1");
  if (!env.DB) throw new Error("D1 DB binding is required");
  const { createD1SceneIndexWriter, readD1WorkerSceneSource, finishD1WorkerSceneIndex } = await import("./d1/scene-index-writer");
  const database = env.DB;
  return { finish: (input: import("./contracts/scene-index").FinishSceneIndexInput) => finishD1WorkerSceneIndex(database, input),
    writer: createD1SceneIndexWriter(database), readSource: (videoId: number) => readD1WorkerSceneSource(database, videoId) };
}

export async function createProcessingQuotaRepository(env: Bindings): Promise<import("./contracts/processing-quota").ProcessingQuotaRepository> {
  if (persistenceBackend(env) === "d1") {
    if (!env.DB) throw new Error("D1 DB binding is required");
    const { createD1ProcessingQuotaRepository } = await import("./d1/processing-quota");
    return createD1ProcessingQuotaRepository(env.DB);
  }
  const { createPostgresProcessingQuotaRepository } = await import("./postgres/processing-quota");
  return createPostgresProcessingQuotaRepository(env);
}

export async function createWorkerTranscriptionRepository(env: Bindings): Promise<import("./contracts/worker-transcription").WorkerTranscriptionRepository> {
  if (persistenceBackend(env) !== "d1") throw new Error("Worker transcription API requires D1");
  if (!env.DB) throw new Error("D1 DB binding is required");
  const { createD1WorkerTranscriptionRepository } = await import("./d1/worker-transcription");
  return createD1WorkerTranscriptionRepository(env.DB);
}

export async function createTranscriptionCheckpoints(env: Bindings): Promise<import("./contracts/transcription-checkpoints").TranscriptionCheckpoints> {
  if (persistenceBackend(env) !== "d1") throw new Error("Worker checkpoint API requires D1");
  if (!env.DB) throw new Error("D1 DB binding is required");
  const { createD1TranscriptionCheckpoints } = await import("./d1/transcription-checkpoints");
  return createD1TranscriptionCheckpoints(env.DB);
}

export async function finishWorkerTranscriptionRun(env: Bindings, videoId: number, runId: string, transcript: string | null) {
  const checkpoints = await createTranscriptionCheckpoints(env);
  const transcription = await createWorkerTranscriptionRepository(env);
  const run = await checkpoints.load(videoId, runId);
  const source = await transcription.readSource(videoId);
  if (!run || !source) return { completed: false, stale: true, status: null };
  if (run.completed) return { completed: true, stale: false, status: source.status };
  if (run.fileKey !== source.fileKey || run.sourceRevision !== source.sourceRevision) return { completed: false, stale: true, status: source.status };
  const status = await transcription.finish(source, transcript, transcript === null ? "TRANSCRIPTION_FAILED" : null, runId);
  return { completed: Boolean((await checkpoints.load(videoId, runId))?.completed), stale: false, status };
}

export async function createVisualCheckpoints(env: Bindings): Promise<import("./contracts/visual-checkpoints").VisualCheckpoints> {
  if (persistenceBackend(env) !== "d1") throw new Error("Worker visual API requires D1");
  if (!env.DB) throw new Error("D1 DB binding is required");
  const { createD1VisualCheckpoints } = await import("./d1/visual-checkpoints");
  return createD1VisualCheckpoints(env.DB);
}

export async function maintainVisualObjects(env: Bindings) {
  if (persistenceBackend(env)!=="d1") return {claimed:0,cleaned:0,failed:0};
  if (!env.DB) throw new Error("D1 DB binding is required");
  const [{maintainD1VisualObjects},{deleteR2Object}]=await Promise.all([
    import("./d1/visual-object-maintenance"),import("../integrations/media"),
  ]);
  return maintainD1VisualObjects(env.DB,key=>deleteR2Object(env,key));
}

export async function createReindexRepository(env:Bindings):Promise<import("./contracts/reindex-repository").ReindexRepository> {
  if (persistenceBackend(env)==="d1") {
    if (!env.DB) throw new Error("D1 DB binding is required");
    const {createD1ReindexRepository}=await import("./d1/reindex-repository");
    return createD1ReindexRepository(env.DB);
  }
  const {createPostgresReindexRepository}=await import("./postgres/reindex-repository");
  return createPostgresReindexRepository(env);
}

export async function readWorkerReindexPage(env:Bindings,input:{afterId:number;dimensions:768|1536;profile:string;model:string}) {
  if (persistenceBackend(env)!=="d1") throw new Error("Worker reindex API requires D1");
  const ids=await (await createReindexRepository(env)).candidateIds(input.afterId);
  if (!ids.length) return ids;
  const embedding=await import("../lib/embedding-contract");
  const config=embedding.resolveEmbeddingConfig(env);
  const dimensions=embedding.embeddingDimensions(config);
  if (dimensions!==input.dimensions || (config.profile??"openai")!==input.profile || config.model!==input.model) throw new Error("Embedding configuration mismatch");
  const index=dimensions===768?env.SCENE_VECTORIZE_768:env.SCENE_VECTORIZE_1536;
  if (!index || (await index.describe()).dimensions!==dimensions) throw new Error("Vector index is not ready");
  return ids;
}

export async function createAiQuotaRepository(env:Bindings):Promise<import("./contracts/ai-quota").AiQuotaRepository> {
  if (persistenceBackend(env)==="d1") {
    if (!env.DB) throw new Error("D1 DB binding is required");
    const {createD1AiQuotaRepository}=await import("./d1/ai-quota");
    return createD1AiQuotaRepository(env.DB);
  }
  const {createPostgresAiQuotaRepository}=await import("./postgres/ai-quota");
  return createPostgresAiQuotaRepository(env);
}

export async function createChatRepository(env:Bindings):Promise<import("./contracts/chat-repository").ChatRepository> {
  if (persistenceBackend(env)==="d1") {
    if (!env.DB) throw new Error("D1 DB binding is required");
    const {createD1ChatRepository}=await import("./d1/chat-repository");return createD1ChatRepository(env.DB);
  }
  const {createPostgresChatRepository}=await import("./postgres/chat-repository");return createPostgresChatRepository(env);
}

export async function openPersistenceConversation(env:Bindings,scope:import("./contracts/conversation").ConversationScope,id:string,requireExisting=false):Promise<import("./contracts/conversation").OpenConversation> {
  if(persistenceBackend(env)==="d1"){
    if(!env.DB)throw new Error("D1 DB binding is required");
    const {openD1Conversation}=await import("./d1/conversation");return openD1Conversation(env.DB,scope,id,requireExisting);
  }
  const {openConversation}=await import("./postgres/conversation");return openConversation(env,scope,id,requireExisting);
}
export async function prunePersistenceConversations(env:Bindings):Promise<number> {
  if(persistenceBackend(env)==="d1"){
    if(!env.DB)throw new Error("D1 DB binding is required");
    const {pruneD1Conversations}=await import("./d1/conversation");return pruneD1Conversations(env.DB);
  }
  const {pruneConversations}=await import("./postgres/conversation");return pruneConversations(env);
}

export async function createConversationRepository(env:Bindings):Promise<import('./contracts/conversation').ConversationRepository> {
  if(persistenceBackend(env)==='d1'){
    if(!env.DB)throw new Error('D1 DB binding is required');
    const {createD1ConversationRepository}=await import('./d1/conversation');return createD1ConversationRepository(env.DB);
  }
  const {createPostgresConversationRepository}=await import('./postgres/conversation');return createPostgresConversationRepository(env);
}

export async function createMembershipRepository(env:Bindings):Promise<import('./contracts/membership-repository').MembershipRepository> {
  if(persistenceBackend(env)==='d1'){
    if(!env.DB)throw new Error('D1 DB binding is required');
    const {createD1MembershipRepository}=await import('./d1/membership-repository');return createD1MembershipRepository(env.DB);
  }
  const pg=await import('./postgres/membership-repository');
  return {reorderVideos:(...args)=>pg.reorderVideos(env,...args),attachTags:(...args)=>pg.attachTags(env,...args),detachTag:(...args)=>pg.detachTag(env,...args),
    addVideoToCourse:(...args)=>pg.addVideoToCourse(env,...args),removeVideoFromCourse:(...args)=>pg.removeVideoFromCourse(env,...args),addVideosBulk:(...args)=>pg.addVideosBulk(env,...args)};
}

export async function createCourseRepository(env:Bindings):Promise<import('./contracts/course-repository').CourseRepository> {
  if(persistenceBackend(env)==='d1'){
    if(!env.DB)throw new Error('D1 DB binding is required');
    const {createD1CourseRepository}=await import('./d1/course-repository');return createD1CourseRepository(env.DB,env);
  }
  const {createPostgresCourseRepository}=await import('./postgres/course-repository');return createPostgresCourseRepository(env);
}

export async function createCredentialRepository(env:Bindings):Promise<import('./contracts/credential-repository').CredentialRepository> {
  if(persistenceBackend(env)==='d1'){
    if(!env.DB)throw new Error('D1 DB binding is required');
    const {createD1CredentialRepository}=await import('./d1/credential-repository');return createD1CredentialRepository(env.DB);
  }
  const {createPostgresCredentialRepository}=await import('./postgres/credential-repository');return createPostgresCredentialRepository(env);
}

export async function createLtiRegistrationRepository(env:Bindings):Promise<import('./contracts/lti-registration-repository').LtiRegistrationRepository> {
  if(persistenceBackend(env)==='d1'){
    if(!env.DB)throw new Error('D1 DB binding is required');
    const {createD1LtiRegistrationRepository}=await import('./d1/lti-registration-repository');return createD1LtiRegistrationRepository(env.DB);
  }
  const {createPostgresLtiRegistrationRepository}=await import('./postgres/lti-registration-repository');return createPostgresLtiRegistrationRepository(env);
}

export async function createToolKeyRepository(env:Bindings):Promise<import('./contracts/tool-key-repository').ToolKeyRepository> {
  if(persistenceBackend(env)==='d1'){
    if(!env.DB)throw new Error('D1 DB binding is required');
    const {createD1ToolKeyRepository}=await import('./d1/tool-keys');return createD1ToolKeyRepository(env.DB);
  }
  const {createPostgresToolKeyRepository}=await import('./postgres/tool-keys');return createPostgresToolKeyRepository(env);
}

export async function createMoodlePairingRepository(env:Bindings):Promise<import('./contracts/moodle-pairing-repository').MoodlePairingRepository> {
  if(persistenceBackend(env)==='d1'){
    if(!env.DB)throw new Error('D1 DB binding is required');
    const {createD1MoodlePairingRepository}=await import('./d1/moodle-pairing-repository');return createD1MoodlePairingRepository(env.DB,env);
  }
  const {createPostgresMoodlePairingRepository}=await import('./postgres/moodle-pairing-repository');return createPostgresMoodlePairingRepository(env);
}

export async function createLmsInstallationRepository(env:Bindings):Promise<import('./contracts/lms-installation-repository').LmsInstallationRepository> {
 if(persistenceBackend(env)==='d1'){
  if(!env.DB)throw new Error('D1 DB binding is required');
  const {createD1LmsInstallationRepository}=await import('./d1/lms-installation-repository');return createD1LmsInstallationRepository(env.DB);
 }
 const {createPostgresLmsInstallationRepository}=await import('./postgres/lms-installation-repository');return createPostgresLmsInstallationRepository(env);
}

export async function createLmsResourceReadRepository(env:Bindings):Promise<import('./contracts/lms-resource-repository').LmsResourceReadRepository> {
 if(persistenceBackend(env)==='d1'){
  if(!env.DB)throw new Error('D1 DB binding is required');
  const {createD1LmsResourceReadRepository}=await import('./d1/lms-resource-read-repository');return createD1LmsResourceReadRepository(env.DB);
 }
 const {createPostgresLmsResourceReadRepository}=await import('./postgres/lms-resource-repository');return createPostgresLmsResourceReadRepository(env);
}

export async function createLmsResourceSyncRepository(env:Bindings):Promise<import('./contracts/lms-resource-repository').LmsResourceSyncRepository> {
 if(persistenceBackend(env)==='d1'){
  if(!env.DB)throw new Error('D1 DB binding is required');
  const {createD1LmsResourceSyncRepository}=await import('./d1/lms-resource-sync');return createD1LmsResourceSyncRepository(env.DB);
 }
 const {createPostgresLmsResourceSyncRepository}=await import('./postgres/lms-resource-repository');return createPostgresLmsResourceSyncRepository(env);
}

export async function createMaterialsSyncRepository(env:Bindings):Promise<import('./contracts/materials-sync-repository').MaterialsSyncRepository> {
 if(persistenceBackend(env)==='d1'){
  if(!env.DB)throw new Error('D1 DB binding is required');
  const {createD1MaterialsSyncRepository}=await import('./d1/materials-sync-repository');return createD1MaterialsSyncRepository(env.DB);
 }
 const {createPostgresMaterialsSyncRepository}=await import('./postgres/materials-sync-repository');return createPostgresMaterialsSyncRepository(env);
}

export async function createNativeSessionRepository(env:Bindings):Promise<import('./contracts/native-session-repository').NativeSessionRepository>{
 if(persistenceBackend(env)==='d1'){
  if(!env.DB)throw new Error('D1 DB binding is required');
  const {createD1NativeSessionRepository}=await import('./d1/native-session-repository');return createD1NativeSessionRepository(env.DB);
 }
 const {createPostgresNativeSessionRepository}=await import('./postgres/native-session-repository');return createPostgresNativeSessionRepository(env);
}

export async function createCourseHistoryRepository(env:Bindings):Promise<import('./contracts/course-history-repository').CourseHistoryRepository>{
 if(persistenceBackend(env)==='d1'){
  if(!env.DB)throw new Error('D1 DB binding is required');
  const {createD1CourseHistoryRepository}=await import('./d1/course-history-repository');return createD1CourseHistoryRepository(env.DB);
 }
 const {createPostgresCourseHistoryRepository}=await import('./postgres/course-history-repository');return createPostgresCourseHistoryRepository(env);
}

export async function createCourseReportRepository(env:Bindings):Promise<import('./contracts/course-report-repository').CourseReportRepository>{
 if(persistenceBackend(env)==='d1'){
  if(!env.DB)throw new Error('D1 DB binding is required');
  const {createD1CourseReportRepository}=await import('./d1/course-report-repository');return createD1CourseReportRepository(env.DB);
 }
 const {createPostgresCourseReportRepository}=await import('./postgres/course-report-repository');return createPostgresCourseReportRepository(env);
}

export async function createAuditRetentionRepository(env:Bindings):Promise<import('./contracts/audit-retention-repository').AuditRetentionRepository>{
 if(persistenceBackend(env)==='d1'){
  if(!env.DB)throw new Error('D1 DB binding is required');
  const {createD1AuditRetentionRepository}=await import('./d1/audit-retention-repository');return createD1AuditRetentionRepository(env.DB);
 }
 const {createPostgresAuditRetentionRepository}=await import('./postgres/audit-retention-repository');return createPostgresAuditRetentionRepository(env);
}

export async function createCourseTagRepository(env:Bindings):Promise<import('./contracts/course-tag-repository').CourseTagRepository>{
 if(persistenceBackend(env)==='d1'){
  if(!env.DB)throw new Error('D1 DB binding is required');
  const {createD1CourseTagRepository}=await import('./d1/course-tag-repository');return createD1CourseTagRepository(env.DB);
 }
 const {createPostgresCourseTagRepository}=await import('./postgres/course-tag-repository');return createPostgresCourseTagRepository(env);
}

export async function createMaterialManagementRepository(env:Bindings):Promise<import('./contracts/material-management-repository').MaterialManagementRepository>{
 if(persistenceBackend(env)==='d1'){
  if(!env.DB)throw new Error('D1 DB binding is required');
  const {createD1MaterialManagementRepository}=await import('./d1/material-management-repository');return createD1MaterialManagementRepository(env.DB);
 }
 const {createPostgresMaterialManagementRepository}=await import('./postgres/material-management-repository');return createPostgresMaterialManagementRepository(env);
}

export async function createPrivacyAuthorizationRepository(env:Bindings):Promise<import('./contracts/privacy-authorization-repository').PrivacyAuthorizationRepository>{
 if(persistenceBackend(env)==='d1'){
  if(!env.DB)throw new Error('D1 DB binding is required');
  const {createD1PrivacyAuthorizationRepository}=await import('./d1/privacy-authorization-repository');return createD1PrivacyAuthorizationRepository(env.DB);
 }
 const {createPostgresPrivacyAuthorizationRepository}=await import('./postgres/privacy-authorization-repository');return createPostgresPrivacyAuthorizationRepository(env);
}

export async function createPrivacyRepository(env:Bindings):Promise<import('./contracts/privacy-repository').PrivacyRepository>{
 if(persistenceBackend(env)==='d1'){
  if(!env.DB)throw new Error('D1 DB binding is required');
  const {createD1PrivacyRepository}=await import('./d1/privacy-repository');return createD1PrivacyRepository(env.DB);
 }
 const {createPostgresPrivacyRepository}=await import('./postgres/privacy-repository');return createPostgresPrivacyRepository(env);
}

export async function createLmsUploadRepository(env:Bindings):Promise<import('./contracts/lms-upload-repository').LmsUploadRepository>{
 if(persistenceBackend(env)==='d1'){
  if(!env.DB)throw new Error('D1 DB binding is required');
  const {createD1LmsUploadRepository}=await import('./d1/lms-upload-repository');return createD1LmsUploadRepository(env.DB);
 }
 const {createPostgresLmsUploadRepository}=await import('./postgres/lms-upload-repository');return createPostgresLmsUploadRepository(env);
}

export async function createAccountIntegrationsRepository(env:Bindings):Promise<import('./contracts/account-integrations-repository').AccountIntegrationsRepository>{
 if(persistenceBackend(env)==='d1'){
  if(!env.DB)throw new Error('D1 DB binding is required');
  const {createD1AccountIntegrationsRepository}=await import('./d1/account-integrations-repository');return createD1AccountIntegrationsRepository(env.DB);
 }
 const {createPostgresAccountIntegrationsRepository}=await import('./postgres/account-integrations-repository');return createPostgresAccountIntegrationsRepository(env);
}

export async function createIdempotencyRetentionRepository(env:Bindings):Promise<import('./contracts/idempotency-retention-repository').IdempotencyRetentionRepository>{
 if(persistenceBackend(env)==='d1'){
  if(!env.DB)throw new Error('D1 DB binding is required');
  const {createD1IdempotencyRetentionRepository}=await import('./d1/idempotency-retention-repository');return createD1IdempotencyRetentionRepository(env.DB);
 }
 const {createPostgresIdempotencyRetentionRepository}=await import('./postgres/idempotency-retention-repository');return createPostgresIdempotencyRetentionRepository(env);
}

export async function createBillingRepository(env:Bindings):Promise<import('./contracts/billing-repository').BillingRepository>{
 if(persistenceBackend(env)==='d1'){
  if(!env.DB)throw new Error('D1 DB binding is required');
  const {createD1BillingRepository}=await import('./d1/billing-repository');return createD1BillingRepository(env.DB);
 }
 const {createPostgresBillingRepository}=await import('./postgres/billing-repository');return createPostgresBillingRepository(env);
}

export async function createAdminUserRepository(env:Bindings):Promise<import('./contracts/admin-user-repository').AdminUserRepository>{
 if(persistenceBackend(env)==='d1'){
  if(!env.DB)throw new Error('D1 DB binding is required');
  const {createD1AdminUserRepository}=await import('./d1/admin-user-repository');return createD1AdminUserRepository(env.DB,env);
 }
 const {createPostgresAdminUserRepository}=await import('./postgres/admin-user-repository');return createPostgresAdminUserRepository(env);
}

export async function stepWorkerAccountDeletion(env:Bindings,lease:import('./contracts/worker-account-deletion').AccountDeletionLease){
 if(persistenceBackend(env)!=='d1'||!env.DB)throw new Error('Internal account deletion requires D1');
 const {createD1WorkerAccountDeletion}=await import('./d1/worker-account-deletion');
 const {armMaintenance}=await import('../lib/task-scheduler');
 return createD1WorkerAccountDeletion(env.DB,async()=>{await armMaintenance(env,Date.now()+1000);}).step(lease);
}

export async function createInvitationDeliveryRepository(env:Bindings):Promise<import('./contracts/invitation-delivery-repository').InvitationDeliveryRepository>{
 if(persistenceBackend(env)==='d1'){
  if(!env.DB)throw new Error('D1 DB binding is required');
  const {createD1InvitationDeliveryRepository}=await import('./d1/invitation-delivery-repository');return createD1InvitationDeliveryRepository(env.DB);
 }
 const {createPostgresInvitationDeliveryRepository}=await import('./postgres/invitation-delivery-repository');return createPostgresInvitationDeliveryRepository(env);
}

export async function createInvitationReadRepository(env:Bindings):Promise<import('./contracts/invitation-read-repository').InvitationReadRepository>{
 if(persistenceBackend(env)==='d1'){
  if(!env.DB)throw new Error('D1 DB binding is required');
  const {createD1InvitationReadRepository}=await import('./d1/invitation-read-repository');return createD1InvitationReadRepository(env.DB);
 }
 const {createPostgresInvitationReadRepository}=await import('./postgres/invitation-read-repository');return createPostgresInvitationReadRepository(env);
}

export async function createInvitationWriteRepository(env:Bindings):Promise<import('./contracts/invitation-write-repository').InvitationWriteRepository>{
 if(persistenceBackend(env)==='d1'){
  if(!env.DB)throw new Error('D1 DB binding is required');
  const {createD1InvitationWriteRepository}=await import('./d1/invitation-write-repository');const {features}=await import('../lib/deployment');
  return createD1InvitationWriteRepository(env.DB,features(env).emailDelivery);
 }
 const {createPostgresInvitationWriteRepository}=await import('./postgres/invitation-write-repository');return createPostgresInvitationWriteRepository(env);
}

export async function createInvitationCreateRepository(env:Bindings):Promise<import('./contracts/invitation-create-repository').InvitationCreateRepository>{
 if(persistenceBackend(env)==='d1'){
  if(!env.DB)throw new Error('D1 DB binding is required');
  const {createD1InvitationCreateRepository}=await import('./d1/invitation-create-repository');const {features}=await import('../lib/deployment');
  return createD1InvitationCreateRepository(env.DB,features(env).emailDelivery);
 }
 const {createPostgresInvitationCreateRepository}=await import('./postgres/invitation-create-repository');return createPostgresInvitationCreateRepository(env);
}

export async function createMultipartUploadRepository(env:Bindings):Promise<import('./contracts/multipart-upload-repository').MultipartUploadRepository>{
 if(persistenceBackend(env)==='d1'){
  if(!env.DB)throw new Error('D1 DB binding is required');
  const {createD1MultipartUploadRepository}=await import('./d1/multipart-upload-repository');return createD1MultipartUploadRepository(env.DB,env);
 }
 const {createPostgresMultipartUploadRepository}=await import('./postgres/multipart-upload-repository');return createPostgresMultipartUploadRepository(env);
}

export async function createQaRepository(env:Bindings):Promise<import('./contracts/qa-repository').QaRepository>{
 if(persistenceBackend(env)==='d1'){
  if(!env.DB)throw new Error('D1 DB binding is required');
  const {createD1QaRepository}=await import('./d1/qa-repository');return createD1QaRepository(env.DB);
 }
 const {createPostgresQaRepository}=await import('./postgres/qa-repository');return createPostgresQaRepository(env);
}

export async function createLinkedLearningRepository(env:Bindings):Promise<import('./contracts/linked-learning-repository').LinkedLearningRepository>{
 if(persistenceBackend(env)==='d1'){
  if(!env.DB)throw new Error('D1 DB binding is required');
  const {createD1LinkedLearningRepository}=await import('./d1/linked-learning-repository');return createD1LinkedLearningRepository(env.DB);
 }
 const {createPostgresLinkedLearningRepository}=await import('./postgres/linked-learning-repository');return createPostgresLinkedLearningRepository(env);
}

export async function createTeachingRepository(env:Bindings):Promise<import('./contracts/teaching-repository').TeachingRepository>{
 if(persistenceBackend(env)==='d1'){
  if(!env.DB)throw new Error('D1 DB binding is required');
  const {createD1TeachingRepository}=await import('./d1/teaching-repository');return createD1TeachingRepository(env.DB);
 }
 const {createPostgresTeachingRepository}=await import('./postgres/teaching-repository');return createPostgresTeachingRepository(env);
}

export async function createLearningMediaRepository(env:Bindings):Promise<import('./contracts/learning-media-repository').LearningMediaRepository>{
 if(persistenceBackend(env)==='d1'){
  if(!env.DB)throw new Error('D1 DB binding is required');
  const {createD1LearningMediaRepository}=await import('./d1/learning-media-repository');return createD1LearningMediaRepository(env.DB);
 }
 const {createPostgresLearningMediaRepository}=await import('./postgres/learning-media-repository');return createPostgresLearningMediaRepository(env);
}
