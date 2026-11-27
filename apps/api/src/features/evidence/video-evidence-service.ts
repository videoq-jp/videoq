import { EvidenceBudget } from '../../domain/conversation/evidence-budget';
import type { VisualMode, VisualInspectionResult, EvidenceNavigation, EvidenceInterval } from '../../domain/media/visual-evidence';
import type { VideoEvidence } from '../../persistence/contracts/video-evidence-repository';
import type { SceneHit } from '../../persistence/contracts/scene-search';
import { transcriptQuality } from '@videoq/domain/transcript-quality';
import { formatEvidenceTime, MAX_FOCUS_INTERVAL_SECONDS, transcriptWindow, transcriptTimeline } from '../../domain/conversation/video-evidence';

export interface VisualEvidenceExecution {
  checkCancelled(): void;
  inspect(video: VideoEvidence, start: number, end: number, query: string,
    options: { mode: VisualMode; maxFrames: number }): Promise<VisualInspectionResult>;
}
export interface VisualEvidenceDependencies {
  videoIds: readonly number[]; visualEnabled: boolean; originalQuestion?: string;
  load(id: number): Promise<VideoEvidence | null>;
}

export function createVideoEvidenceService(deps: VisualEvidenceDependencies) {
  const budget = new EvidenceBudget();
  let inspectionTail = Promise.resolve();
  const allowed = new Set(deps.videoIds);
  const respond = (result: object) => ({
    ...result,
    budget: {
      ...budget.remaining(),
      note: "Shared per execution scope; includes reservations for concurrent calls. An overview uses up to 16 images; a focus uses up to 16. Reserve images for comparing candidate intervals. Tool completion alone does not mean useful evidence was found.",
    },
  });
  const check = (id: number, start = 0, end = 1, maxInterval = 180) => {
    if (!allowed.has(id)) return "Invalid video_id: only the current course's videos may be read.";
    if (end <= start || end - start > maxInterval) return `Specify a positive interval of at most ${maxInterval} seconds.`;
    return null;
  };
  const describe = (hit: SceneHit) => ({
    videoId: hit.videoId, title: hit.videoTitle,
    startTime: hit.startTime, endTime: hit.endTime, evidenceType: hit.evidenceType ?? "transcript", text: hit.content,
    ...(hit.evidenceType === "visual" ? {} : { transcript_quality: transcriptQuality(hit) }),
  });
  const visualEnabled = deps.visualEnabled;
  const visualNote = "Sparse still-frame observations only. Unseen moments, motion, fine details and missing steps are not established. Empty observations do not prove content is absent. Narrow an interval only if useful; stop when sufficient evidence is collected.";
  const inspect = async (
    video: VideoEvidence,
    start: number, end: number, query: string, mode: VisualMode, execution: VisualEvidenceExecution,
  ) => {
    if (!visualEnabled) return { status: "unavailable", unavailable: "Visual inspection is disabled. Only subtitles were checked." };
    if (video.sourceType !== "uploaded" || !video.fileKey) return { status: "unavailable", unavailable: "Visual inspection is available only for uploaded videos, not YouTube imports." };
    // Reserve before awaiting: parallel calls share both count and image budgets.
    const reservation = budget.reserveVisual(mode);
    if (!reservation) return { status: "unavailable", unavailable: "Visual inspection limit reached (4 calls / 48 frames shared across all viewing tools). Use collected evidence." };
    const { maxFrames } = reservation;
    // Only one bounded cache/model payload in flight per execution scope.
    const previous = inspectionTail;
    let release!: () => void;
    inspectionTail = new Promise<void>(resolve => { release = resolve; });
    await previous;
    try {
      execution.checkCancelled();
      const visualQuery = deps.originalQuestion ? `Original user question: ${deps.originalQuestion}\nSpecific inspection task: ${query}` : query;
      const result = await execution.inspect(video, start, end, visualQuery, { mode, maxFrames });
      const actualFrames = "unavailable" in result ? 0 : result.sampled_timestamps.length;
      reservation.settle(actualFrames);
      if ("unavailable" in result) return { ...result, status: "unavailable" };
      return {
        ...result,
        status: result.observations.length ? "observed" : "no_observations",
        observations: result.observations.map(observation => ({ timestamp_seconds: observation.timestamp, ...describe({
          videoId: video.id, videoTitle: video.title,
          startTime: formatEvidenceTime(observation.timestamp), endTime: formatEvidenceTime(observation.timestamp),
          content: observation.text, evidenceType: "visual",
        }) })),
        note: mode === "focus"
          ? "Dense stills at approximately one-second intervals, with actual presentation timestamps. Source gaps and sub-second events may be missed. These frames establish only visible states; do not invent unseen motion or intermediate steps."
          : visualNote,
      };
    } finally { release(); }
  };
  const timeline = (video: VideoEvidence, start = 0, end = Infinity) => {
    if (video.transcriptTooLarge) return { unavailable: "Transcript is too large for timeline reading; use search_scenes." };
    const result = transcriptTimeline(video, start, end);
    return { ...result, scenes: result.scenes.map(describe), note: "Time-distributed subtitle excerpts, not a complete transcript or summary. Missing topics may occur between samples. Use read_video_window or search_scenes for details. The last subtitle time is not the video duration." };
  };

  const overview = async ({ video_id, query, include_visuals }: EvidenceNavigation, execution: VisualEvidenceExecution) => {
    execution.checkCancelled();
    const error = check(video_id);
    if (error) return error;
    const key = `overview|${video_id}|${include_visuals}|${query}`;
    const reserved = budget.reserveTool('overview', key);
    if (reserved === 'limit') return "Video overview limit reached. Use collected evidence or narrow an existing interval.";
    if (reserved === 'duplicate') return "This overview was already requested. Use the existing timeline.";
    const video = await deps.load(video_id);
    execution.checkCancelled();
    if (!video) return "This video is unavailable or not ready.";
    return respond({
      videoId: video.id, title: video.title, subtitles: timeline(video),
      visuals: include_visuals ? await inspect(video, 0, Infinity, query, "overview", execution) : { status: "skipped", skipped: "Visuals were not requested." },
    });
  };
  const skim = async ({ video_id, start_seconds, end_seconds, query, include_visuals }: EvidenceNavigation & EvidenceInterval, execution: VisualEvidenceExecution) => {
    execution.checkCancelled();
    const error = check(video_id, start_seconds, end_seconds, 900);
    if (error) return error;
    const key = `skim|${video_id}|${start_seconds}|${end_seconds}|${include_visuals}|${query}`;
    const reserved = budget.reserveTool('skim', key);
    if (reserved === 'limit') return "Video skim limit reached. Use collected evidence or inspect a known short interval.";
    if (reserved === 'duplicate') return "This interval was already skimmed. Use existing evidence or narrow the interval.";
    const video = await deps.load(video_id);
    execution.checkCancelled();
    if (!video) return "This video is unavailable or not ready.";
    return respond({
      videoId: video.id, title: video.title, start_seconds, end_seconds,
      subtitles: timeline(video, start_seconds, end_seconds),
      visuals: include_visuals ? await inspect(video, start_seconds, end_seconds, query, "skim", execution) : { status: "skipped", skipped: "Visuals were not requested." },
    });
  };
  const readWindow = async ({ video_id, start_seconds, end_seconds, context_seconds }: EvidenceInterval & { context_seconds: number }, execution: VisualEvidenceExecution) => {
    execution.checkCancelled();
    const error = check(video_id, start_seconds, end_seconds);
    if (error) return error;
    if (budget.reserveTool('window') === 'limit') return "Transcript window limit reached. Answer from collected evidence and state any gaps.";
    const video = await deps.load(video_id);
    execution.checkCancelled();
    if (!video) return "This video is unavailable or not ready.";
    if (video.transcriptTooLarge) return "Transcript is too large for window reading; use search_scenes.";
    const result = transcriptWindow(video, start_seconds, end_seconds, context_seconds);
    return respond({
      start_seconds: result.start, end_seconds: result.end, truncated: result.truncated,
      scenes: result.scenes.map(describe),
      note: result.scenes.length ? "Subtitle cue timestamps are preserved; overlapping cues can extend outside the requested window." : "No subtitles overlap this window. This says nothing about visible content.",
    });
  };
  const inspectClip = async ({ video_id, start_seconds, end_seconds, query }: EvidenceInterval & { query: string }, execution: VisualEvidenceExecution) => {
    execution.checkCancelled();
    const error = check(video_id, start_seconds, end_seconds);
    if (error) return error;
    const key = `${video_id}|${start_seconds}|${end_seconds}|${query}`;
    const reserved = budget.reserveTool('inspect', key);
    if (reserved === 'limit') return "Visual inspection limit reached. Answer from collected evidence and state any gaps.";
    if (reserved === 'duplicate') return "This clip and query were already inspected. Use the existing observations.";
    const video = await deps.load(video_id);
    execution.checkCancelled();
    if (!video) return "This video is unavailable or not ready.";
    return respond(await inspect(video, start_seconds, end_seconds, query, "inspect", execution));
  };
  const focus = async ({ video_id, start_seconds, end_seconds, query }: EvidenceInterval & { query: string }, execution: VisualEvidenceExecution) => {
    execution.checkCancelled();
    const error = check(video_id, start_seconds, end_seconds, MAX_FOCUS_INTERVAL_SECONDS);
    if (error) return error;
    const key = `focus|${video_id}|${start_seconds}|${end_seconds}|${query}`;
    const reserved = budget.reserveTool('focus', key);
    if (reserved === 'limit') return "Focus limit reached. Answer from collected evidence and state any gaps.";
    if (reserved === 'duplicate') return "This dense clip was already inspected. Use existing evidence or a different interval.";
    const video = await deps.load(video_id);
    execution.checkCancelled();
    if (!video) return "This video is unavailable or not ready.";
    return respond(await inspect(video, start_seconds, end_seconds, query, "focus", execution));
  };
  return { overview, skim, readWindow, inspectClip, focus };
}
