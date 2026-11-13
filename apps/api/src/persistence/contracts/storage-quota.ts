export type StorageReservationResult =
  | { ok: true }
  | { overQuota: true }
  | { exceeded: true; limit: number };

export type UploadReservationResult =
  | { ok: true; periodStart: string }
  | { overQuota: true }
  | { exceeded: true; limit: number }
  | { monthlyUploadExceeded: true; limit: number };

