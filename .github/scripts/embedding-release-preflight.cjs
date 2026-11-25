'use strict';
// Read-only gate before a strict API candidate receives traffic. No adoption or writes.
const { createHash } = require('node:crypto');
const fs = require('node:fs');
function identity(vars) {
  const value = key => typeof vars[key] === 'string' ? vars[key].trim() : '';
  const provider = value('EMBEDDING_PROVIDER') || 'openai';
  const profile = value('EMBEDDING_PROFILE') || 'openai';
  if (!['openai','workers-ai'].includes(provider) || !['openai','embeddinggemma2'].includes(profile)) throw Error('INVALID_EMBEDDING_RELEASE_CONFIG');
  const model = value('EMBEDDING_MODEL') || (provider === 'workers-ai' ? '@cf/google/embeddinggemma-2' : 'text-embedding-3-small');
  if (provider === 'workers-ai' && (profile !== 'embeddinggemma2' || model !== '@cf/google/embeddinggemma-2')) throw Error('INVALID_EMBEDDING_RELEASE_CONFIG');
  if (provider === 'openai' && profile === 'embeddinggemma2' && (!value('EMBEDDING_MODEL') || !value('EMBEDDING_BASE_URL'))) throw Error('INVALID_EMBEDDING_RELEASE_CONFIG');
  const gemma = profile === 'embeddinggemma2', dimensions = gemma ? 768 : 1536;
  const canonical = JSON.stringify(['videoq-embedding-v1', provider, model, value('EMBEDDING_REVISION') || 'provider-managed', profile, dimensions,
    gemma ? 'task: search result | query: ' : '', gemma ? 'title: none | text: ' : '',
    value('EMBEDDING_PREPROCESSING') || 'raw-text-v1', 'float32-nonzero-v1', 'preserve-newlines']);
  return { dimensions, fingerprint: createHash('sha256').update(canonical).digest('hex') };
}
const SQL = `WITH incompatible_runs AS (
 SELECT r.id FROM scene_index_runs r JOIN video_index_heads h ON h.run_id=r.id AND h.video_id=r.video_id AND h.dimensions=r.dimensions
 WHERE r.dimensions=?1 AND (r.embedding_fingerprint IS NULL OR r.embedding_fingerprint<>?2)
), incompatible_scenes AS (
 SELECT s.id FROM scenes s LEFT JOIN scene_index_runs r ON r.id=s.revision AND r.video_id=s.video_id AND r.dimensions=s.dimensions
 WHERE s.dimensions=?1 AND (r.embedding_fingerprint IS NULL OR r.embedding_fingerprint<>?2)
), incompatible_writes AS (
 SELECT t.id FROM scene_index_tasks t LEFT JOIN scene_index_runs r ON r.id=t.revision AND r.video_id=t.video_id AND r.dimensions=t.dimensions AND r.user_id=t.user_id
 WHERE t.dimensions=?1 AND t.operation='upsert' AND t.completed_at IS NULL AND (r.embedding_fingerprint IS NULL OR r.embedding_fingerprint<>?2)
) SELECT (SELECT count(*) FROM incompatible_runs) AS incompatible_runs,
 (SELECT count(*) FROM incompatible_scenes) AS incompatible_scenes,
 (SELECT count(*) FROM incompatible_writes) AS incompatible_writes`;
function assertCounts(row) {
  if (!row || !['incompatible_runs','incompatible_scenes','incompatible_writes'].every(key => Number.isSafeInteger(row[key]) && row[key] >= 0)) throw Error('EMBEDDING_RELEASE_PREFLIGHT_UNAVAILABLE');
  if (Object.values(row).some(value => value !== 0)) throw Error('EMBEDDING_RELEASE_REBUILD_REQUIRED');
}
async function preflight(target, env = process.env, fetcher = fetch, { resume = false } = {}) {
  if (!target?.vars || !Array.isArray(target.d1_databases)) throw Error('INVALID_EMBEDDING_RELEASE_CONFIG');
  const config = identity(target.vars);
  const state = target.vars.MIGRATION_TRAFFIC_STATE;
  if (state !== undefined && !['running','paused'].includes(state)) throw Error('INVALID_EMBEDDING_RELEASE_TRAFFIC_STATE');
  // A paused candidate cannot admit HTTP work. This does not authorize resume.
  if (state === 'paused' && !resume) return { serving: false, ...config };
  const databases = target.d1_databases.filter(binding => binding.binding === 'DB');
  if (databases.length !== 1 || !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(databases[0].database_id || '') ||
      !/^[a-f0-9]{32}$/.test(env.CLOUDFLARE_ACCOUNT_ID || '') || !env.CLOUDFLARE_API_TOKEN) throw Error('EMBEDDING_RELEASE_PREFLIGHT_UNAVAILABLE');
  const response = await fetcher(`https://api.cloudflare.com/client/v4/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/d1/database/${databases[0].database_id}/query`, {
    method: 'POST', redirect: 'error', signal: AbortSignal.timeout(20000),
    headers: { authorization: 'Bearer ' + env.CLOUDFLARE_API_TOKEN, 'content-type': 'application/json' },
    body: JSON.stringify({ sql: SQL, params: [config.dimensions, config.fingerprint] }),
  });
  if (!response.ok || !response.body) throw Error('EMBEDDING_RELEASE_PREFLIGHT_UNAVAILABLE');
  const chunks = []; let size = 0;
  for await (const chunk of response.body) {
    size += chunk.byteLength;
    if (size > 65536) throw Error('EMBEDDING_RELEASE_PREFLIGHT_UNAVAILABLE');
    chunks.push(Buffer.from(chunk));
  }
  let data;
  try { data = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw Error('EMBEDDING_RELEASE_PREFLIGHT_UNAVAILABLE'); }
  if (data.success !== true || data.result?.length !== 1 || data.result[0].success !== true || data.result[0].results?.length !== 1) throw Error('EMBEDDING_RELEASE_PREFLIGHT_UNAVAILABLE');
  assertCounts(data.result[0].results[0]);
  return { serving: true, ...config };
}
module.exports = { identity, SQL, assertCounts, preflight };
if (require.main === module) {
  const [file, mode, ...rest] = process.argv.slice(2);
  Promise.resolve().then(() => {
    if (!file || (mode !== undefined && mode !== '--resume') || rest.length) throw Error('INVALID_EMBEDDING_RELEASE_ARGUMENTS');
    return preflight(JSON.parse(fs.readFileSync(file, 'utf8')), process.env, fetch, { resume: mode === '--resume' });
  }).then(result => console.log(JSON.stringify(result))).catch(error => {
    console.error(['EMBEDDING_RELEASE_REBUILD_REQUIRED','INVALID_EMBEDDING_RELEASE_CONFIG','INVALID_EMBEDDING_RELEASE_TRAFFIC_STATE'].includes(error.message) ? error.message : 'EMBEDDING_RELEASE_PREFLIGHT_UNAVAILABLE');
    process.exitCode = 1;
  });
}
