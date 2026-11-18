// Ordinary CD may update code, but must not reopen a paused service or silently
// replace an active D1 target. Deliberate cutover/recovery uses its own procedure.
const fs = require('node:fs');
function backend(vars) {
  if (vars.DEPLOYMENT_EDITION !== undefined && !['cloud','onprem'].includes(vars.DEPLOYMENT_EDITION)) throw Error('INVALID_DEPLOYMENT_STATE');
  const value = vars.PERSISTENCE_BACKEND ?? (vars.DEPLOYMENT_EDITION === 'cloud' ? 'd1' : 'postgres');
  if (!['d1','postgres'].includes(value)) throw Error('INVALID_DEPLOYMENT_STATE');
  return value;
}
function paused(value) { return value !== undefined && value !== 'running'; }
function assertDeploymentPreservesState(settings, target) {
  if (!Array.isArray(settings?.bindings) || target?.name !== 'videoq-api' || !target.vars || typeof target.vars !== 'object') throw Error('INVALID_DEPLOYMENT_STATE');
  const names = ['DEPLOYMENT_EDITION','PERSISTENCE_BACKEND','MIGRATION_TRAFFIC_STATE'];
  const current = {};
  for (const key of names) {
    const matches = settings.bindings.filter(binding => binding.name === key);
    if (matches.length > 1 || matches.some(binding => binding.type !== 'plain_text' || typeof binding.text !== 'string')) throw Error('INVALID_DEPLOYMENT_STATE');
    if (matches.length) current[key] = matches[0].text;
  }
  if (paused(current.MIGRATION_TRAFFIC_STATE) && !paused(target.vars.MIGRATION_TRAFFIC_STATE)) throw Error('PAUSED_SERVICE_REQUIRES_CONTROLLED_RESUME');
  const selected = backend(target.vars);
  if (backend(current) === 'd1') {
    if (selected !== 'd1') throw Error('D1_BACKEND_REQUIRES_CONTROLLED_ROLLBACK');
    const db = settings.bindings.filter(binding => binding.type === 'd1' && binding.name === 'DB');
    const next = (target.d1_databases ?? []).filter(binding => binding.binding === 'DB');
    if (db.length !== 1 || next.length !== 1 || !db[0].id || db[0].id !== next[0].database_id) throw Error('D1_TARGET_REQUIRES_CONTROLLED_MIGRATION');
    for (const name of ['SCENE_VECTORIZE_1536','SCENE_VECTORIZE_768']) {
      const index = settings.bindings.filter(binding => binding.name === name);
      const replacement = (target.vectorize ?? []).filter(binding => binding.binding === name);
      // The optional 768-dimensional index may be retired out of band.
      // Ordinary CD must still preserve every active binding and cannot add one.
      if (name === 'SCENE_VECTORIZE_768' && index.length === 0 && replacement.length === 0) continue;
      if (index.length !== 1 || replacement.length !== 1 || index[0].type !== 'vectorize' || !index[0].index_name || index[0].index_name !== replacement[0].index_name) throw Error('VECTOR_TARGET_REQUIRES_CONTROLLED_MIGRATION');
    }
  }
  return { deploymentStatePreserved: true };
}
async function readDeploymentSettings(env = process.env, fetcher = fetch) {
  if (!/^[a-f0-9]{32}$/.test(env.CLOUDFLARE_ACCOUNT_ID ?? '') || !env.CLOUDFLARE_API_TOKEN) throw Error('DEPLOYMENT_STATE_CHECK_UNAVAILABLE');
  const response = await fetcher(`https://api.cloudflare.com/client/v4/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/workers/scripts/videoq-api/settings`, {
    method: 'GET', redirect: 'error', signal: AbortSignal.timeout(20000),
    headers: { authorization: 'Bearer '+env.CLOUDFLARE_API_TOKEN },
  });
  if (!response.ok || !response.body) throw Error('DEPLOYMENT_STATE_CHECK_UNAVAILABLE');
  const chunks = []; let size = 0;
  for await (const chunk of response.body) {
    size += chunk.byteLength;
    if (size > 1024*1024) throw Error('DEPLOYMENT_STATE_CHECK_UNAVAILABLE');
    chunks.push(Buffer.from(chunk));
  }
  const result = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  if (result.success !== true) throw Error('DEPLOYMENT_STATE_CHECK_UNAVAILABLE');
  return result.result;
}
async function protect(target, env = process.env, fetcher = fetch) {
  return assertDeploymentPreservesState(await readDeploymentSettings(env, fetcher), target);
}
module.exports = { assertDeploymentPreservesState, protect, readDeploymentSettings };
if (require.main === module) {
  const args = process.argv.slice(2);
  Promise.resolve().then(() => {
    if (args.length !== 1) throw Error('INVALID_DEPLOYMENT_STATE');
    return protect(JSON.parse(fs.readFileSync(args[0], 'utf8')));
  }).then(result => console.log(JSON.stringify(result))).catch(() => {
    console.error('API deployment refused: verify deployed pause/backend/target state through the controlled cutover or recovery procedure.');
    process.exitCode = 1;
  });
}
