import type { Vectorize } from "@cloudflare/workers-types";
import type { SceneIndexTask } from "../contracts/scene-index";

/** An acknowledgement or getByIds response alone does not prove ANN visibility. */
export async function isSceneVectorQueryable(index: Pick<Vectorize, "queryById">, task: SceneIndexTask): Promise<boolean> {
  const filter = { user_id: task.userId, video_id: task.videoId, vector_id: task.vectorId };
  if (new TextEncoder().encode(JSON.stringify(filter)).length >= 2048) return false;
  try {
    const result = await index.queryById(task.vectorId, {
      topK: 1, returnValues: false, returnMetadata: "all", filter,
    });
    const match = result.matches?.[0];
    return result.matches?.length === 1 && match?.id === task.vectorId && Number.isFinite(match.score) &&
      match.metadata?.vector_id === task.vectorId && match.metadata?.scene_id === task.sceneId &&
      match.metadata?.revision === task.revision && match.metadata?.user_id === task.userId &&
      match.metadata?.video_id === task.videoId;
  } catch {
    // Missing/unpropagated vectors and provider errors remain retryable. Never
    // copy provider payloads into diagnostics or infer readiness from elapsed time.
    return false;
  }
}
