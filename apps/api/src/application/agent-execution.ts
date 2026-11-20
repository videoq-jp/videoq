import { MAX_SCENE_SEARCHES, MAX_COURSE_INFO_CALLS } from './evidence';
import { MAX_WINDOW_READS, MAX_CLIP_INSPECTIONS, MAX_OVERVIEWS, MAX_SKIMS, MAX_FOCUS_CALLS } from './video-evidence';

export const MAX_TOOL_ROUNDS = MAX_SCENE_SEARCHES + MAX_COURSE_INFO_CALLS + MAX_WINDOW_READS
  + MAX_CLIP_INSPECTIONS + MAX_OVERVIEWS + MAX_SKIMS + MAX_FOCUS_CALLS;

/** Select capabilities for an already-authorized scope; this does not grant access. */
export function hasAgentContext(scope: { courseId?: number | null; videoIds: readonly number[] | null }): boolean {
  return scope.courseId != null || (scope.videoIds !== null && scope.videoIds.length > 0);
}

/** Invalid tool attempts also consume a round; the final model call has no tools. */
export class AnswerAgentBudget {
  private modelCalls = 0;

  allowToolsForNextModelCall(): boolean {
    return ++this.modelCalls <= MAX_TOOL_ROUNDS;
  }
}
