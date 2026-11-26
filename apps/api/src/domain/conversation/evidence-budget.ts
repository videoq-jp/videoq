import { MAX_WINDOW_READS, MAX_OVERVIEWS, MAX_SKIMS, MAX_CLIP_INSPECTIONS, MAX_FOCUS_CALLS,
  MAX_VISUAL_CALLS, MAX_VISUAL_FRAMES, MAX_FOCUS_FRAMES, MAX_OVERVIEW_FRAMES, MAX_CLIP_FRAMES } from './video-evidence';
import { MAX_SCENE_SEARCHES, MAX_COURSE_INFO_CALLS } from './evidence';
const limits = { window: MAX_WINDOW_READS, overview: MAX_OVERVIEWS, skim: MAX_SKIMS, inspect: MAX_CLIP_INSPECTIONS, focus: MAX_FOCUS_CALLS,
  search: MAX_SCENE_SEARCHES, course: MAX_COURSE_INFO_CALLS } as const;
export type EvidenceTool = keyof typeof limits;
/** Synchronous reservations precede external awaits, including parallel calls. */
export class EvidenceBudget {
  private counts = new Map<EvidenceTool, number>();
  private seen = new Set<string>();
  private visualCalls = 0;
  private visualFrames = 0;
  hasCapacity(tool: EvidenceTool): boolean { return (this.counts.get(tool) ?? 0) < limits[tool]; }
  reserveTool(tool: EvidenceTool, key?: string): 'accepted' | 'limit' | 'duplicate' {
    const used = this.counts.get(tool) ?? 0;
    if (used >= limits[tool]) return 'limit';
    if (key !== undefined && this.seen.has(key)) return 'duplicate';
    if (key !== undefined) this.seen.add(key);
    this.counts.set(tool, used + 1); return 'accepted';
  }
  reserveVisual(mode: 'overview' | 'skim' | 'inspect' | 'focus') {
    if (this.visualCalls >= MAX_VISUAL_CALLS || this.visualFrames >= MAX_VISUAL_FRAMES) return null;
    const maxFrames = Math.min(mode === 'focus' ? MAX_FOCUS_FRAMES : mode === 'overview' ? MAX_OVERVIEW_FRAMES : MAX_CLIP_FRAMES, MAX_VISUAL_FRAMES - this.visualFrames);
    this.visualCalls++; this.visualFrames += maxFrames;
    let settled = false;
    return { maxFrames, settle: (actualFrames: number) => { if (!settled) { this.visualFrames -= maxFrames - actualFrames; settled = true; } } };
  }
  remaining() {
    return { remaining_visual_calls: Math.max(0, MAX_VISUAL_CALLS - this.visualCalls), remaining_images: Math.max(0, MAX_VISUAL_FRAMES - this.visualFrames),
      remaining_focus_calls: Math.max(0, MAX_FOCUS_CALLS - (this.counts.get('focus') ?? 0)) };
  }
}
export function externalEvidencePlan(tool: string, args: Record<string, unknown>) {
  const visual = tool === 'inspect_clip' || tool === 'focus_clip' || args.include_visuals === true;
  return { paid: tool === 'search_scenes' || visual,
    cost: visual ? (tool === 'overview_video' || tool === 'focus_clip' ? 16 : 8) : 1 };
}
