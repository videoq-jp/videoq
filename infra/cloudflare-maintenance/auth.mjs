// GitHub-signed identity only. No shared bearer secret or caller-selected issuer.
export const ISSUER = 'https://token.actions.githubusercontent.com';
export const AUDIENCE = 'videoq-maintenance-prod';
export const REPOSITORY = 'videoq-jp/videoq';
const purposes = {
  migration: { environment: 'production-db-migration', workflows: ['cd.yml', 'database-migrate.yml'] },
  smoke: { environment: 'production-db-smoke', workflows: ['operations.yml'] },
};
export async function boundedJson(response, limit = 128 * 1024) {
  if (!response.ok || !response.body) { await response.body?.cancel().catch(() => {}); throw Error('METADATA_UNAVAILABLE'); }
  const reader = response.body.getReader(); const parts = []; let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read(); if (done) break;
      size += value.byteLength; if (size > limit) throw Error('METADATA_TOO_LARGE'); parts.push(value);
    }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const part of parts) { bytes.set(part, offset); offset += part.length; }
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
}
function decode(value) {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw Error('OIDC_REQUIRED');
  return Uint8Array.from(atob(value.replaceAll('-', '+').replaceAll('_', '/')), c => c.charCodeAt(0));
}
export async function verifyIdentity(token, kind, { fetcher = fetch, now = Date.now, cryptoProvider = crypto, statusOnly = false } = {}) {
  const purpose = purposes[kind];
  if (!purpose || typeof token !== 'string' || token.length > 20000) throw Error('OIDC_REQUIRED');
  const parts = token.split('.'); if (parts.length !== 3) throw Error('OIDC_REQUIRED');
  const parse = part => JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(decode(part)));
  const header = parse(parts[0]);
  if (header.alg !== 'RS256' || header.typ !== 'JWT' || typeof header.kid !== 'string' || header.kid.length > 256 || header.crit) throw Error('OIDC_REQUIRED');
  const keys = await boundedJson(await fetcher(ISSUER + '/.well-known/jwks', {
    redirect: 'manual', signal: AbortSignal.timeout(10000), cf: { cacheTtl: 3600, cacheEverything: true },
  }));
  if (!Array.isArray(keys.keys) || keys.keys.length > 20) throw Error('OIDC_REQUIRED');
  const selected = keys.keys.filter(key => key.kid === header.kid && key.kty === 'RSA' && key.use === 'sig' && key.alg === 'RS256');
  if (selected.length !== 1) throw Error('OIDC_REQUIRED');
  const key = await cryptoProvider.subtle.importKey('jwk', selected[0], { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
  if (!await cryptoProvider.subtle.verify('RSASSA-PKCS1-v1_5', key, decode(parts[2]), new TextEncoder().encode(parts[0] + '.' + parts[1]))) throw Error('OIDC_REQUIRED');
  const c = parse(parts[1]), seconds = Math.floor(now() / 1000);
  if (c.iss !== ISSUER || c.aud !== AUDIENCE || c.repository !== REPOSITORY || c.repository_id !== '1083911938' || c.repository_owner_id !== '349188820'
    || c.ref !== 'refs/heads/main' || c.ref_type !== 'branch' || c.environment !== purpose.environment || c.runner_environment !== 'github-hosted'
    || c.sub !== `repo:videoq-jp@349188820/videoq@1083911938:environment:${purpose.environment}` || !['workflow_run', 'workflow_dispatch', 'schedule'].includes(c.event_name)
    || !(statusOnly ? c.workflow_ref === `${REPOSITORY}/.github/workflows/maintenance-status.yml@refs/heads/main` : purpose.workflows.some(file => c.workflow_ref === `${REPOSITORY}/.github/workflows/${file}@refs/heads/main`))
    || !/^[a-f0-9]{40}$/.test(c.sha ?? '') || !/^[a-f0-9]{40}$/.test(c.workflow_sha ?? '') || c.workflow_sha !== c.sha
    || !/^[1-9][0-9]{0,19}$/.test(c.run_id ?? '') || !/^[1-9][0-9]{0,5}$/.test(c.run_attempt ?? '')
    || ![c.exp,c.iat,c.nbf].every(Number.isSafeInteger) || c.exp <= seconds || c.nbf > seconds + 30 || c.iat > seconds + 30 || c.exp - c.iat > 600 || c.iat < seconds - 600) throw Error('OIDC_REQUIRED');
  return { access: statusOnly ? 'status' : 'operate', kind, runId: c.run_id, attempt: Number(c.run_attempt), source: c.sha, workflow: c.workflow_ref.slice(`${REPOSITORY}/.github/workflows/`.length).split('@')[0] };
}
export async function verifyStart(identity, githubToken, { fetcher = fetch, recovery = false } = {}) {
  if (typeof githubToken !== 'string' || githubToken.length < 20 || /[\r\n\0]/.test(githubToken)) throw Error('GITHUB_METADATA_REQUIRED');
  const get = async path => boundedJson(await fetcher(`https://api.github.com/repos/${REPOSITORY}/${path}`, {
    headers: { authorization: 'Bearer ' + githubToken, accept: 'application/vnd.github+json', 'user-agent': 'videoq-maintenance' }, redirect: 'manual', signal: AbortSignal.timeout(10000),
  }));
  const run = await get('actions/runs/' + identity.runId);
  if (String(run.id) !== identity.runId || run.run_attempt !== identity.attempt || run.head_sha !== identity.source || run.head_branch !== 'main'
    || !['in_progress', 'queued', 'waiting', 'pending'].includes(run.status) || run.path !== `.github/workflows/${identity.workflow}` || run.repository?.id !== 1083911938) throw Error('GITHUB_RUN_REQUIRED');
  // A parallel job awaiting a runner or environment approval can leave the
  // aggregate run queued/waiting while this OIDC-authenticated job is executing.
  // Admit that case only with independent proof of the exact maintenance job.
  if (run.status !== 'in_progress') {
    const jobName = { 'cd.yml': 'Drizzle DB Migrate', 'database-migrate.yml': 'verify', 'operations.yml': 'production-smoke', 'maintenance-status.yml': `status (${identity.kind}, production-db-${identity.kind})` }[identity.workflow];
    const result = await get(`actions/runs/${identity.runId}/attempts/${identity.attempt}/jobs?per_page=100`);
    if (!jobName || !Array.isArray(result.jobs) || !Number.isSafeInteger(result.total_count) || result.total_count < 1
      || result.total_count > 100 || result.jobs.length !== result.total_count
      || result.jobs.filter(job => job.name === jobName && job.status === 'in_progress' && job.conclusion === null
        && String(job.run_id) === identity.runId && job.head_sha === identity.source && job.completed_at === null).length !== 1) throw Error('GITHUB_RUN_REQUIRED');
  }
  const commits = await get('git/ref/heads/main');
  if (!recovery && commits.object?.sha !== identity.source) throw Error('CANONICAL_MAIN_REQUIRED');
  const ci = await get(`actions/workflows/ci.yml/runs?branch=main&head_sha=${identity.source}&event=push&per_page=1`);
  if (!Array.isArray(ci.workflow_runs) || ci.workflow_runs.length > 100 || ci.workflow_runs.some(r => !Number.isSafeInteger(r.id) || r.id <= 0)) throw Error('MAIN_CI_REQUIRED');
  const latest = [...ci.workflow_runs].sort((a,b) => b.id-a.id)[0];
  if (!latest || latest.head_sha !== identity.source || latest.head_branch !== 'main' || latest.event !== 'push' || latest.status !== 'completed' || latest.conclusion !== 'success' || latest.repository?.id !== 1083911938 || latest.head_repository?.id !== 1083911938) throw Error('MAIN_CI_REQUIRED');
}
