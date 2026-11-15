export type ProcessingReservation = { allowed: boolean; limitSeconds: number | null };
export interface ProcessingQuotaRepository {
  reserve(videoId: number, seconds: number): Promise<ProcessingReservation>;
}
export function validateProcessingReservation(videoId: number, seconds: number) {
  if (!Number.isSafeInteger(videoId) || videoId <= 0 || !Number.isSafeInteger(seconds) || seconds <= 0 || seconds > 2_147_483_647) {
    throw new Error("Processing reservation requires positive safe integers");
  }
}
