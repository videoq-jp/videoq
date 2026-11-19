import { tool } from "langchain";
import { createCourseInfoTool } from "../tools/course-info";
import type { Bindings } from "../types/bindings";
export { MAX_COURSE_INFO_CALLS, COURSE_DESCRIPTION_LIMIT, VIDEO_DESCRIPTION_LIMIT } from "../tools/course-info";

/** Compatibility adapter for existing direct-tool consumers; RAG uses MCP. */
export function courseInfoTool(env: Bindings, scope: { courseId: number; ownerUserId: string }, collectContext: (text: string) => void) {
  const definition = createCourseInfoTool(env, scope);
  return tool(async input => {
    const value = await definition.invoke(input, { signal: new AbortController().signal });
    if (typeof value === "string") return value;
    const text = JSON.stringify(value);
    collectContext(`Course metadata (not subtitle scenes): ${text}`);
    return text;
  }, definition);
}
