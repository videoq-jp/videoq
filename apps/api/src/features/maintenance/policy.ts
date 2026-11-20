/** Keep completed retry history beyond the queue's maximum delivery lifetime. */
export function retentionBounds(retentionDays = 30, limit = 500) {
  if (!Number.isSafeInteger(retentionDays) || retentionDays < 1) {
    throw new Error('retentionDays must be a positive integer.');
  }
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 5000) {
    throw new Error('limit must be an integer between 1 and 5000.');
  }
  return { retentionDays, limit };
}
