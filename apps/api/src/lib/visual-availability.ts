/** Public guidance only: no storage paths, run IDs, or operator credentials. */
export function unpreparedVisualEvidence(message = "Visual evidence is not available for this video yet.") {
  return {
    unavailable: message,
    reason: "VISUALS_NOT_PREPARED" as const,
    next_action: "Ask the video owner or administrator to prepare visual data. Subtitle evidence is still available.",
  };
}
