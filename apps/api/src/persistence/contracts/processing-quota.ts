export type ProcessingReservation = { allowed: boolean; limitSeconds: number | null };
export interface ProcessingQuotaRepository {
  reserve(videoId: number, seconds: number): Promise<ProcessingReservation>;
}
export { validateProcessingReservation } from '../../application/quota-policy';
