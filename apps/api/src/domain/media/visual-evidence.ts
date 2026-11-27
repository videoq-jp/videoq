export type VisualMode = 'overview' | 'skim' | 'inspect' | 'focus';
export type VisualInspectionResult = {
  observations: { timestamp: number; text: string }[];
  sampled_timestamps: number[]; sampling_interval_seconds: number; duration_seconds: number;
} | { unavailable: string; sampling_interval_seconds?: number; reason?: string; next_action?: string };
export type EvidenceInterval = { video_id: number; start_seconds: number; end_seconds: number };
export type EvidenceNavigation = { video_id: number; query: string; include_visuals: boolean };

/** Public guidance contains no storage paths, run identities or credentials. */
export function unpreparedVisualEvidence(message = 'Visual evidence is not available for this video yet.') {
  return {
    unavailable: message,
    reason: 'VISUALS_NOT_PREPARED' as const,
    next_action: 'Ask the video owner or administrator to prepare visual data. Subtitle evidence is still available.',
  };
}
