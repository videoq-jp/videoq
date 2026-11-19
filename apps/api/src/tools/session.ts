import { openSceneSearch, type SceneSearch } from "../repositories/vector-repository";
import type { Bindings } from "../types/bindings";
import type { EvidenceScope } from "../repositories/video-evidence-repository";
import { createSceneSearchTool } from "./scene-search";
import { createVideoEvidenceTools } from "./video-evidence";
import { createCourseInfoTool } from "./course-info";
import type { UsageRecorder } from "./usage";

export type EvidenceToolScope = EvidenceScope & { courseId?: number | null };

/** One bounded execution scope. No agent, graph, citation registry or HTTP credentials. */
export function createEvidenceSession(
  env: Bindings, inputScope: EvidenceToolScope, signal: AbortSignal,
  options: { question?: string; usage?: UsageRecorder } = {},
) {
  const scope = { ...inputScope, videoIds: [...inputScope.videoIds] };
  let pending: Promise<SceneSearch> | undefined;
  const search: SceneSearch = {
    async search(query, videoIds, callSignal) {
      signal.throwIfAborted();
      if (!scope.videoIds.length) return [];
      pending ??= openSceneSearch(env, { userId: scope.ownerUserId, videoIds: scope.videoIds }, signal, options.usage);
      return (await pending).search(query, videoIds, callSignal);
    },
    async close() {
      const connection = await pending?.catch(() => undefined);
      try { await connection?.close(); }
      catch (error) {
        console.error(JSON.stringify({ event: "evidence_search_close_failed", errorType: error instanceof Error ? error.name : "unknown" }));
      }
    },
  };
  return {
    tools: [
      createSceneSearchTool(search, scope.videoIds),
      ...createVideoEvidenceTools(env, scope, options.question, options.usage),
      ...(scope.courseId != null ? [createCourseInfoTool(env, { courseId: scope.courseId, ownerUserId: scope.ownerUserId, videoIds: scope.videoIds })] : []),
    ],
    close: () => search.close(),
  };
}
