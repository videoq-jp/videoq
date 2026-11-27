/** Numeric entries written by older deployments remain charged until expiry. */
export type RateLimitEntry = number | { at: number; reservationId: string };
export const consumptionTime = (entry: RateLimitEntry): number => typeof entry === 'number' ? entry : entry.at;

/** Histories are newest-first. Reservations identify all units of one consume. */
export function pruneExpiredHistory<T extends RateLimitEntry>(history: readonly T[], nowSec: number, windowSec: number): T[] {
  return history.filter(entry => consumptionTime(entry) > nowSec - windowSec);
}
export function refundReservation(history: readonly RateLimitEntry[], reservationId: string): RateLimitEntry[] {
  // A pre-upgrade caller can send a numeric cost at runtime: never refund an
  // unidentified entry. Mixed deployments fail closed rather than deleting B.
  return history.filter(entry => typeof entry === 'number' || typeof reservationId !== 'string' || entry.reservationId !== reservationId);
}
export function consumptionEntries(now: number, cost: number, reservationId?: string): RateLimitEntry[] {
  return Array.from({ length: cost }, () => reservationId ? { at: now, reservationId } : now);
}
export function validateRateLimit(limit: number, windowSec: number, cost: number): void {
  if (![limit, windowSec, cost].every(value => Number.isSafeInteger(value) && value > 0)) throw new Error('Invalid rate limit');
}

/** For a denied request, wait until enough units expire (history is newest-first).
 * A cost larger than the limit can never fit; retain the bounded rejection hint.
 * Concurrent consumption can of course move availability after this snapshot.
 */
export function consumptionRetryAfter(history: readonly RateLimitEntry[], now: number, windowSec: number, limit: number, cost: number): number {
  if (cost > limit) return windowSec;
  const lastRequiredExpiry = history[limit - cost];
  return lastRequiredExpiry === undefined ? windowSec
    : Math.max(1, Math.ceil(consumptionTime(lastRequiredExpiry) + windowSec - now));
}
