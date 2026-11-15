import { tool } from "langchain";
import { z } from "zod";
import { getVideoEvidence, type EvidenceScope } from "../repositories/video-evidence-repository";
import type { SceneHit } from "../repositories/vector-repository";
import type { Bindings } from "../types/bindings";
import { inspectVideoClip, type VisualMode } from "./visual-inspection";
import type { AnswerCostLedger } from "./answer-cost-ledger";
import { transcriptQuality } from "./transcript-quality";
import {
  formatEvidenceTime, MAX_CLIP_INSPECTIONS, MAX_WINDOW_READS, MAX_OVERVIEWS, MAX_SKIMS,
  MAX_VISUAL_CALLS, MAX_VISUAL_FRAMES, MAX_OVERVIEW_FRAMES, MAX_CLIP_FRAMES,
  MAX_FOCUS_CALLS, MAX_FOCUS_FRAMES, videoVisualEnabled, transcriptWindow, transcriptTimeline,
} from "./video-evidence";

const interval = {
  video_id: z.number().int().positive().safe(),
  start_seconds: z.number().finite().min(0).max(3_600_000),
  end_seconds: z.number().finite().min(0).max(3_600_000),
};

export function videoEvidenceTools(
  env: Bindings, scope: EvidenceScope, addSource: (hit: SceneHit) => number, signal: AbortSignal,
  originalQuestion?: string,
  costLedger?: AnswerCostLedger,
) {
  let windowReads = 0;
  let inspections = 0;
  let overviews = 0;
  let skims = 0;
  let focuses = 0;
  let visualCalls = 0;
  let visualFrames = 0;
  let inspectionTail = Promise.resolve();
  const seen = new Set<string>();
  const allowed = new Set(scope.videoIds);
  const respond = (result: object) => JSON.stringify({
    ...result,
    budget: {
      remaining_visual_calls: Math.max(0, MAX_VISUAL_CALLS - visualCalls),
      remaining_images: Math.max(0, MAX_VISUAL_FRAMES - visualFrames),
      remaining_focus_calls: Math.max(0, MAX_FOCUS_CALLS - focuses),
      note: "Shared per answer; includes reservations for concurrent calls. An overview uses up to 16 images; a focus uses up to 16. Reserve images for comparing candidate intervals. Tool completion alone does not mean useful evidence was found.",
    },
  });
  const check = (id: number, start = 0, end = 1, maxInterval = 180) => {
    signal.throwIfAborted();
    if (!allowed.has(id)) return "Invalid video_id: only the current course's videos may be read.";
    if (end <= start || end - start > maxInterval) return `Specify a positive interval of at most ${maxInterval} seconds.`;
    return null;
  };
  const describe = (hit: SceneHit) => ({
    sourceId: addSource(hit), videoId: hit.videoId, title: hit.videoTitle,
    startTime: hit.startTime, endTime: hit.endTime, evidenceType: hit.evidenceType ?? "transcript", text: hit.content,
    ...(hit.evidenceType === "visual" ? {} : { transcript_quality: transcriptQuality(hit) }),
  });
  const visualEnabled = videoVisualEnabled(env.VIDEO_VISUAL_ENABLED);
  const visualNote = "Sparse still-frame observations only. Unseen moments, motion, fine details and missing steps are not established. Empty observations do not prove content is absent. Narrow an interval only if useful; stop when sufficient evidence is collected.";
  const inspect = async (
    video: NonNullable<Awaited<ReturnType<typeof getVideoEvidence>>>,
    start: number, end: number, query: string, mode: VisualMode,
  ) => {
    if (!visualEnabled) return { status: "unavailable", unavailable: "Visual inspection is disabled. Only subtitles were checked." };
    if (video.sourceType !== "uploaded" || !video.fileKey) return { status: "unavailable", unavailable: "Visual inspection is available only for uploaded videos, not YouTube imports." };
    // Reserve before awaiting: parallel calls share both count and image budgets.
    if (visualCalls >= MAX_VISUAL_CALLS || visualFrames >= MAX_VISUAL_FRAMES) {
      return { status: "unavailable", unavailable: "Visual inspection limit reached (4 calls / 48 frames shared across all viewing tools). Use collected evidence." };
    }
    const maxFrames = Math.min(mode === "focus" ? MAX_FOCUS_FRAMES : mode === "overview" ? MAX_OVERVIEW_FRAMES : MAX_CLIP_FRAMES, MAX_VISUAL_FRAMES - visualFrames);
    visualCalls++;
    visualFrames += maxFrames;
    // Only one bounded cache/model payload in flight per answer.
    const previous = inspectionTail;
    let release!: () => void;
    inspectionTail = new Promise<void>(resolve => { release = resolve; });
    await previous;
    try {
      signal.throwIfAborted();
      const visualQuery = originalQuestion ? `Original user question: ${originalQuestion}\nSpecific inspection task: ${query}` : query;
      const result = await inspectVideoClip(env, { id: video.id, fileKey: video.fileKey, ...(video.visualRunId !== undefined ? { visualRunId: video.visualRunId,visualManifestVersion:video.visualManifestVersion } : {}) }, start, end, visualQuery, signal, { mode, maxFrames }, ...(costLedger ? [costLedger] : []));
      const actualFrames = "unavailable" in result ? 0 : result.sampled_timestamps.length;
      visualFrames -= maxFrames - actualFrames;
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
  const timeline = (video: NonNullable<Awaited<ReturnType<typeof getVideoEvidence>>>, start = 0, end = Infinity) => {
    if (video.transcriptTooLarge) return { unavailable: "Transcript is too large for timeline reading; use search_scenes." };
    const result = transcriptTimeline(video, start, end);
    return { ...result, scenes: result.scenes.map(describe), note: "Time-distributed subtitle excerpts, not a complete transcript or summary. Missing topics may occur between samples. Use read_video_window or search_scenes for details. The last subtitle time is not the video duration." };
  };
  const navigationFields = {
    query: z.string().trim().min(1).max(2000),
    include_visuals: z.boolean().describe(visualEnabled
      ? "True only when visible content is needed or subtitles cannot locate it. False uses subtitles without a vision call."
      : "Set false: visual inspection is disabled; subtitle navigation remains available."),
  };
  const overview = tool(async ({ video_id, query, include_visuals }) => {
    const error = check(video_id);
    if (error) return error;
    if (overviews >= MAX_OVERVIEWS) return "Video overview limit reached. Use collected evidence or narrow an existing interval.";
    const key = `overview|${video_id}|${include_visuals}|${query}`;
    if (seen.has(key)) return "This overview was already requested. Use the existing timeline.";
    seen.add(key);
    overviews++;
    const video = await getVideoEvidence(env, scope, video_id);
    signal.throwIfAborted();
    if (!video) return "This video is unavailable or not ready.";
    return respond({
      videoId: video.id, title: video.title, subtitles: timeline(video),
      visuals: include_visuals ? await inspect(video, 0, Infinity, query, "overview") : { status: "skipped", skipped: "Visuals were not requested." },
    });
  }, {
    name: "overview_video",
    description: "Survey one current-course video across its entire timeline using up to 12 subtitle excerpts and optionally 16 low-detail cached images. Use to orient a broad summary or locate a visual topic when its time is unknown, even without subtitle search hits. This is sampled evidence, not full coverage. Identify video_id using get_course_info or search_scenes. Maximum 2 overviews per answer. Visuals share a 4-call / 48-frame budget with skim_video, inspect_clip and focus_clip. Follow useful timestamps with skim_video, read_video_window, inspect_clip or focus_clip; do not force every step.",
    schema: z.object({ video_id: interval.video_id, ...navigationFields }).strict(),
  });
  const skim = tool(async ({ video_id, start_seconds, end_seconds, query, include_visuals }) => {
    const error = check(video_id, start_seconds, end_seconds, 900);
    if (error) return error;
    if (skims >= MAX_SKIMS) return "Video skim limit reached. Use collected evidence or inspect a known short interval.";
    const key = `skim|${video_id}|${start_seconds}|${end_seconds}|${include_visuals}|${query}`;
    if (seen.has(key)) return "This interval was already skimmed. Use existing evidence or narrow the interval.";
    seen.add(key);
    skims++;
    const video = await getVideoEvidence(env, scope, video_id);
    signal.throwIfAborted();
    if (!video) return "This video is unavailable or not ready.";
    return respond({
      videoId: video.id, title: video.title, start_seconds, end_seconds,
      subtitles: timeline(video, start_seconds, end_seconds),
      visuals: include_visuals ? await inspect(video, start_seconds, end_seconds, query, "skim") : { status: "skipped", skipped: "Visuals were not requested." },
    });
  }, {
    name: "skim_video",
    description: "Scan a candidate interval (up to 900 seconds) with up to 12 time-distributed subtitle excerpts and optionally 8 low-detail cached images to locate relevant moments. Use after an overview, search hit or user-specified timestamp; no fixed tool order is required. Narrow useful timestamps with read_video_window, inspect_clip or focus_clip. Maximum 2 skims per answer. Visuals share a 4-call / 48-frame budget across viewing tools. Sparse samples do not establish absence between them.",
    schema: z.object({ ...interval, ...navigationFields }).strict(),
  });
  const readWindow = tool(async ({ video_id, start_seconds, end_seconds, context_seconds }) => {
    const error = check(video_id, start_seconds, end_seconds);
    if (error) return error;
    if (windowReads++ >= MAX_WINDOW_READS) return "Transcript window limit reached. Answer from collected evidence and state any gaps.";
    const video = await getVideoEvidence(env, scope, video_id);
    signal.throwIfAborted();
    if (!video) return "This video is unavailable or not ready.";
    if (video.transcriptTooLarge) return "Transcript is too large for window reading; use search_scenes.";
    const result = transcriptWindow(video, start_seconds, end_seconds, context_seconds);
    return respond({
      start_seconds: result.start, end_seconds: result.end, truncated: result.truncated,
      scenes: result.scenes.map(describe),
      note: result.scenes.length ? "Subtitle cue timestamps are preserved; overlapping cues can extend outside the requested window." : "No subtitles overlap this window. This says nothing about visible content.",
    });
  }, {
    name: "read_video_window",
    description: "Read subtitles in a known video interval, with up to 30 seconds of surrounding context. Use after search_scenes to recover prerequisites, omitted explanations or adjacent steps. Accepts seconds, preserves original cue timestamps and sourceIds. Maximum 3 calls per answer; 180-second interval; output may be truncated.",
    schema: z.object({ ...interval, context_seconds: z.number().int().min(0).max(30) }).strict(),
  });
  const inspectClip = tool(async ({ video_id, start_seconds, end_seconds, query }) => {
    const error = check(video_id, start_seconds, end_seconds);
    if (error) return error;
    if (inspections >= MAX_CLIP_INSPECTIONS) return "Visual inspection limit reached. Answer from collected evidence and state any gaps.";
    const key = `${video_id}|${start_seconds}|${end_seconds}|${query}`;
    if (seen.has(key)) return "This clip and query were already inspected. Use the existing observations.";
    seen.add(key);
    inspections++;
    const video = await getVideoEvidence(env, scope, video_id);
    signal.throwIfAborted();
    if (!video) return "This video is unavailable or not ready.";
    return respond(await inspect(video, start_seconds, end_seconds, query, "inspect"));
  }, {
    name: "inspect_clip",
    description: "Read stable diagrams, equations, labels or screen contents over a known interval using up to 8 high-detail stills at least 5 seconds apart. For a known interval of at most 16 seconds, especially counts, motion, ordering or brief appearances, prefer focus_clip. Maximum 2 calls, 180 seconds; shares a 4-call / 48-frame visual budget. Uploaded videos with a frame cache only.",
    schema: z.object({ ...interval, query: z.string().trim().min(1).max(2000) }).strict(),
  });
  const focus = tool(async ({ video_id, start_seconds, end_seconds, query }) => {
    const error = check(video_id, start_seconds, end_seconds, 16);
    if (error) return error;
    if (focuses >= MAX_FOCUS_CALLS) return "Focus limit reached. Answer from collected evidence and state any gaps.";
    const key = `focus|${video_id}|${start_seconds}|${end_seconds}|${query}`;
    if (seen.has(key)) return "This dense clip was already inspected. Use existing evidence or a different interval.";
    seen.add(key);
    focuses++;
    const video = await getVideoEvidence(env, scope, video_id);
    signal.throwIfAborted();
    if (!video) return "This video is unavailable or not ready.";
    return respond(await inspect(video, start_seconds, end_seconds, query, "focus"));
  }, {
    name: "focus_clip",
    description: "Densely inspect a short uploaded-video interval of at most 16 seconds using up to 16 high-detail images selected approximately once per second, preserving actual timestamps. Use for brief visible steps, changing equations or details missed by sparse overview/skim/inspect images. For visual highlights, check the candidate's lead-in, action and outcome; a lone notification is not a complete event. Go directly to a user-specified time or narrow a candidate from other tools. Dense cache is required; never pretend sparse stills are dense evidence. Source gaps and sub-second events may still be missed. Maximum 2 calls; all viewing tools share 4 visual calls / 48 images per answer. Check returned budget before planning another interval. YouTube imports have no image inspection.",
    schema: z.object({
      ...interval,
      end_seconds: interval.end_seconds.describe("Exclusive end time. To inspect the frame at 4 seconds, end at 5 seconds or later. The interval must still be at most 16 seconds."),
      query: z.string().trim().min(1).max(2000),
    }).strict(),
  });
  return visualEnabled ? [readWindow, inspectClip, overview, skim, focus] : [readWindow, overview, skim];
}
