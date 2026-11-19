/** Explicit capability policy; MCP annotations are descriptive, not authorization. */
const answerTools: ReadonlySet<string> = new Set([
  "search_scenes", "get_course_info", "read_video_window", "inspect_clip", "overview_video", "skim_video", "focus_clip",
]);
export function isAnswerTool(name: string): boolean { return answerTools.has(name); }
