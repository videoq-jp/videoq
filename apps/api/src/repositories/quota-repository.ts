import type {Bindings} from "../types/bindings";
import type {AiAnswerReservation,AiAnswerReservationResult} from "../persistence/contracts/ai-quota";
import {createAiQuotaRepository} from "../persistence/factory";
export type {AiAnswerReservation,AiAnswerReservationResult} from "../persistence/contracts/ai-quota";
export type {StorageReservationResult,UploadReservationResult} from "../persistence/contracts/storage-quota";
// Compatibility exports for transactions that are still PostgreSQL-specific.
export {uploadUsageIsCurrent,currentUploadBytes,reserveUploadInTransaction,refundUnconfirmedUpload,reserveStorageInTransaction} from "../persistence/postgres/storage-quota";

export async function reserveAiAnswerUsage(env:Bindings,userId:string):Promise<AiAnswerReservationResult> {
  return (await createAiQuotaRepository(env)).reserve(userId);
}
export async function releaseAiAnswerReservation(env:Bindings,reservation:AiAnswerReservation):Promise<void> {
  return (await createAiQuotaRepository(env)).release(reservation);
}
