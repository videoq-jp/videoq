import { sha256, type FrozenCourse } from './environment';

/** Fixed SELECT only. Returns a private pin including membership identity. */
export async function readLiveSourcePin(options: {
  source: FrozenCourse; accountId: string; databaseId: string;
  token: () => Promise<string>; fetch?: typeof fetch;
}) {
  if (!/^[a-f0-9]{32}$/.test(options.accountId) || !/^[a-f0-9-]{36}$/.test(options.databaseId)) throw new Error('INVALID_LIVE_SOURCE_TARGET');
  const { source } = options;
  const ids = source.videos.map(v => v.id).sort((a, b) => a - b);
  if (!ids.length || ids.length > 3 || ids.some(id => !Number.isSafeInteger(id) || id <= 0) || !Number.isSafeInteger(source.courseId) || source.courseId <= 0) throw new Error('INVALID_LIVE_SOURCE_SCOPE');
  const sql = `SELECT v.id AS video_id, v.user_id, v.status, v.title, iv.revision, m.id AS membership_id,
    r.id AS run_id, r.source_revision, r.dimensions, r.embedding_identity, r.embedding_fingerprint, r.expected_scenes, r.status AS run_status
    FROM videos v JOIN video_course_members m ON m.video_id=v.id
    JOIN video_courses c ON c.id=m.course_id AND c.user_id=v.user_id
    JOIN video_index_versions iv ON iv.video_id=v.id
    JOIN video_index_heads h ON h.video_id=v.id AND h.dimensions=768
    JOIN scene_index_runs r ON r.id=h.run_id AND r.video_id=v.id AND r.user_id=v.user_id
    WHERE m.course_id=? AND v.id IN (${ids.map(() => '?').join(',')}) ORDER BY v.id`;
  const response = await (options.fetch ?? fetch)(`https://api.cloudflare.com/client/v4/accounts/${options.accountId}/d1/database/${options.databaseId}/query`, {
    redirect: 'error', method: 'POST', headers: { Authorization: `Bearer ${await options.token()}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ sql, params: [source.courseId, ...ids] }), signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`LIVE_SOURCE_HTTP_${response.status}`);
  const payload = await response.json<{ success?: boolean; result?: { success?: boolean; results?: Record<string, unknown>[] }[] }>();
  const rows = payload.result?.[0]?.results;
  if (payload.success !== true || payload.result?.[0]?.success !== true || !Array.isArray(rows) || rows.length !== ids.length) throw new Error('LIVE_SOURCE_UNAVAILABLE');
  for (const [index, row] of rows.entries()) {
    const video = source.videos.find(v => v.id === ids[index])!, run = source.runs.find(r => r.video_id === video.id);
    if (!run || row.video_id !== video.id || row.user_id !== video.user_id || row.title !== video.title || row.status !== 'completed' || row.revision !== video.revision || !Number.isSafeInteger(row.membership_id) || Number(row.membership_id) <= 0
      || row.run_id !== run.id || row.source_revision !== run.source_revision || row.dimensions !== run.dimensions || row.embedding_identity !== run.embedding_identity || row.embedding_fingerprint !== run.embedding_fingerprint || row.expected_scenes !== run.expected_scenes || row.run_status !== 'published') throw new Error('LIVE_SOURCE_CHANGED');
  }
  // The pin includes membership IDs, so removing/re-adding a video cannot make
  // an interrupted comparison silently resume against a new membership.
  return sha256(JSON.stringify(rows));
}
