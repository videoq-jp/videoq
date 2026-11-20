import { defineTool } from "./definition";
import { z } from "zod";
import { getVideoEvidence, type EvidenceScope } from "../repositories/video-evidence-repository";
import type { Bindings } from "../types/bindings";
import { inspectVideoClip } from "../lib/visual-inspection";
import type { UsageRecorder } from "./usage";
import { videoVisualEnabled } from "../lib/video-evidence";
import { createVideoEvidenceService, type VisualEvidenceExecution } from "../features/evidence/video-evidence-service";

const interval = {
  video_id: z.number().int().positive().safe(),
  start_seconds: z.number().finite().min(0).max(3_600_000),
  end_seconds: z.number().finite().min(0).max(3_600_000),
};

export function createVideoEvidenceTools(
  env: Bindings, scope: EvidenceScope,
  originalQuestion?: string,
  costLedger?: UsageRecorder,
) {
  const visualEnabled = videoVisualEnabled(env.VIDEO_VISUAL_ENABLED);
  const service = createVideoEvidenceService({ videoIds: scope.videoIds, visualEnabled, originalQuestion,
    load: id => getVideoEvidence(env, scope, id) });
  const execution = (signal: AbortSignal): VisualEvidenceExecution => ({
    checkCancelled: () => signal.throwIfAborted(),
    inspect: (video, start, end, query, options) => inspectVideoClip(env,
      { id: video.id, fileKey: video.fileKey, ...(video.visualRunId !== undefined ? { visualRunId: video.visualRunId, visualManifestVersion: video.visualManifestVersion } : {}) },
      start, end, query, signal, options, ...(costLedger ? [costLedger] : [])),
  });
  const navigationFields = {
    query: z.string().trim().min(1).max(2000),
    include_visuals: z.boolean().describe(visualEnabled
      ? "True only when visible content is needed or subtitles cannot locate it. False uses subtitles without a vision call."
      : "Set false: visual inspection is disabled; subtitle navigation remains available."),
  };
  const overview = defineTool((input, { signal }) => service.overview(input, execution(signal)), {
    name: "overview_video",
    description: "Survey one current-course video across its entire timeline using up to 12 subtitle excerpts and optionally 16 low-detail cached images. Use to orient a broad summary or locate a visual topic when its time is unknown, even without subtitle search hits. This is sampled evidence, not full coverage. Identify video_id using get_course_info or search_scenes. Maximum 2 overviews per execution scope. Visuals share a 4-call / 48-frame budget with skim_video, inspect_clip and focus_clip. Follow useful timestamps with skim_video, read_video_window, inspect_clip or focus_clip; do not force every step.",
    schema: z.object({ video_id: interval.video_id, ...navigationFields }).strict(),
  });
  const skim = defineTool((input, { signal }) => service.skim(input, execution(signal)), {
    name: "skim_video",
    description: "Scan a candidate interval (up to 900 seconds) with up to 12 time-distributed subtitle excerpts and optionally 8 low-detail cached images to locate relevant moments. Use after an overview, search hit or user-specified timestamp; no fixed tool order is required. Narrow useful timestamps with read_video_window, inspect_clip or focus_clip. Maximum 2 skims per execution scope. Visuals share a 4-call / 48-frame budget across viewing tools. Sparse samples do not establish absence between them.",
    schema: z.object({ ...interval, ...navigationFields }).strict(),
  });
  const readWindow = defineTool((input, { signal }) => service.readWindow(input, execution(signal)), {
    name: "read_video_window",
    description: "Read subtitles in a known video interval, with up to 30 seconds of surrounding context. Use after search_scenes to recover prerequisites, omitted explanations or adjacent steps. Accepts seconds, preserves original cue timestamps. Maximum 3 calls per execution scope; 180-second interval; output may be truncated.",
    schema: z.object({ ...interval, context_seconds: z.number().int().min(0).max(30) }).strict(),
  });
  const inspectClip = defineTool((input, { signal }) => service.inspectClip(input, execution(signal)), {
    name: "inspect_clip",
    description: "Read stable diagrams, equations, labels or screen contents over a known interval using up to 8 high-detail stills at least 5 seconds apart. For a known interval of at most 16 seconds, especially counts, motion, ordering or brief appearances, prefer focus_clip. Maximum 2 calls, 180 seconds; shares a 4-call / 48-frame visual budget. Uploaded videos with a frame cache only.",
    schema: z.object({ ...interval, query: z.string().trim().min(1).max(2000) }).strict(),
  });
  const focus = defineTool((input, { signal }) => service.focus(input, execution(signal)), {
    name: "focus_clip",
    description: "Densely inspect a short uploaded-video interval of at most 16 seconds using up to 16 high-detail images selected approximately once per second, preserving actual timestamps. Use for brief visible steps, changing equations or details missed by sparse overview/skim/inspect images. For visual highlights, check the candidate's lead-in, action and outcome; a lone notification is not a complete event. Go directly to a user-specified time or narrow a candidate from other tools. Dense cache is required; never pretend sparse stills are dense evidence. Source gaps and sub-second events may still be missed. Maximum 2 calls; all viewing tools share 4 visual calls / 48 images per execution scope. Check returned budget before planning another interval. YouTube imports have no image inspection.",
    schema: z.object({
      ...interval,
      end_seconds: interval.end_seconds.describe("Exclusive end time. To inspect the frame at 4 seconds, end at 5 seconds or later. The interval must still be at most 16 seconds."),
      query: z.string().trim().min(1).max(2000),
    }).strict(),
  });
  return visualEnabled ? [readWindow, inspectClip, overview, skim, focus] : [readWindow, overview, skim];
}
