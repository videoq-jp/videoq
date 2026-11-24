/** Real-browser CORS fixture. Use only a dedicated local Garage bucket. */
import { createServer, request as httpRequest } from 'node:http';
import { once } from 'node:events';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { corsMiddleware } from '../src/middleware/cors.ts';
import { presignR2Put, createR2MultipartUpload, presignR2UploadPart, completeR2MultipartUpload,
  deleteR2Object, abortR2MultipartUpload, readMediaBytes } from '../src/integrations/media.ts';

const storage = process.env.CORS_ACCEPTANCE_STORAGE_URL;
if (process.env.CORS_ACCEPTANCE_ISOLATED !== '1' || !storage || !['127.0.0.1', 'localhost'].includes(new URL(storage).hostname)) {
  throw new Error('Use CORS_ACCEPTANCE_ISOLATED=1 and a dedicated loopback CORS_ACCEPTANCE_STORAGE_URL');
}
const reportPath = process.argv[2]; if (!reportPath) throw new Error('Pass the sanitized result JSON path');
const storageTarget = new URL(storage);
if (storageTarget.protocol !== 'http:') throw new Error('The local Garage fixture requires HTTP');
const bucket = 'videoq-cors-acceptance';
const prefix = `/cors-${randomUUID()}`;
const cookieName = `cors_${randomUUID().replaceAll('-', '')}`;
const trace = [], results = {}, fixtures = new Map(), servers = [];
let allowedOrigin, deniedOrigin, apiOrigin, proxyOrigin;
const env = { ENVIRONMENT: 'development', USE_S3_STORAGE: 'true', R2_ACCESS_KEY_ID: 'GK00000000000000000000000000000000',
  R2_SECRET_ACCESS_KEY: '0'.repeat(64), R2_BUCKET_NAME: bucket, R2_S3_REGION: 'garage', R2_S3_INTERNAL_ENDPOINT: storage };
const clientJs = await readFile(new URL('./cors-acceptance.browser.js', import.meta.url), 'utf8');
const headersForTrace = headers => Object.fromEntries(['access-control-allow-origin', 'access-control-allow-credentials',
  'access-control-allow-headers', 'access-control-allow-methods', 'access-control-expose-headers', 'vary']
  .map(name => [name, headers.get(name)]).filter(([, value]) => value !== null));
async function listen(server) {
  servers.push(server); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  return `http://127.0.0.1:${server.address().port}`;
}
const proxy = createServer((req, res) => {
  const url = new URL(req.url, 'http://fixture');
  const operation = url.searchParams.has('partNumber') ? 'upload_part' : req.method === 'PUT' ? 'signed_put' : req.method;
  const upstream = httpRequest({ hostname: storageTarget.hostname, port: storageTarget.port,
    path: url.pathname + url.search, method: req.method, headers: req.headers }, response => {
    const headers = new Headers(Object.entries(response.headers).flatMap(([name, value]) => value === undefined ? [] : [[name, String(value)]]));
    trace.push({ layer: 'storage', role: req.headers.origin === allowedOrigin ? 'allowed' : req.headers.origin === deniedOrigin ? 'denied' : undefined, method: req.method, operation,
      origin: req.headers.origin ?? null, requestedHeaders: req.headers['access-control-request-headers'] ?? null,
      status: response.statusCode, responseHeaders: headersForTrace(headers) });
    res.writeHead(response.statusCode, response.headers); response.pipe(res);
  });
  upstream.on('error', () => { res.writeHead(502); res.end('Fixture upstream unavailable'); }); req.pipe(upstream);
});
proxyOrigin = await listen(proxy); env.R2_S3_ENDPOINT = proxyOrigin;
const app = new Hono();
app.onError((_error, c) => c.json({ code: 'SYNTHETIC_ERROR' }, 500));
app.use('*', async (c, next) => {
  await next();
  trace.push({ layer: 'api', method: c.req.method, operation: c.req.path.replace(prefix, '/fixture'),
    origin: c.req.header('origin') ?? null, requestedHeaders: c.req.header('access-control-request-headers') ?? null,
    status: c.res.status, responseHeaders: headersForTrace(c.res.headers) });
});
app.use('*', corsMiddleware);
app.use('*', async (c, next) => { c.header('X-Request-Id', 'cors-probe'); await next(); });
const hasCookie = c => (c.req.header('cookie') ?? '').split(';').some(part => part.trim() === `${cookieName}=synthetic`);
app.get(`${prefix}/session`, c => { c.header('Set-Cookie', `${cookieName}=synthetic; Path=${prefix}/; HttpOnly; SameSite=Lax; Max-Age=120`); return c.json({ ok: true }); });
app.get(`${prefix}/cookie`, c => c.json({ cookie: hasCookie(c) }, hasCookie(c) ? 200 : 401));
app.post(`${prefix}/write`, c => c.json({ cookie: hasCookie(c) }, hasCookie(c) ? 200 : 401));
app.get(`${prefix}/error`, () => { throw new Error('Synthetic fixture error'); });
app.post('/api/mcp', c => { c.header('WWW-Authenticate', 'Bearer realm="synthetic"'); return c.json({ error: 'unauthorized' }, 401); });
app.post(`${prefix}/complete`, async c => {
  if (!hasCookie(c)) return c.json({ error: 'cookie required' }, 401);
  const input = await c.req.json(); const fixture = fixtures.get(input.fixture);
  if (!fixture || fixture.role !== 'allowed' || !Array.isArray(input.parts) || input.parts.length !== 2 ||
      !input.parts.every((part, index) => part.partNumber === index + 1 && typeof part.etag === 'string' && /^[a-f0-9-]+$/i.test(part.etag))) return c.json({ error: 'invalid parts' }, 400);
  await completeR2MultipartUpload(env, fixture.multipartKey, fixture.uploadId, input.parts); fixture.completed = true;
  const bytes = await readMediaBytes(env, fixture.multipartKey, fixture.expected.length);
  const hashMatches = !!bytes && createHash('sha256').update(bytes).digest('hex') === createHash('sha256').update(fixture.expected).digest('hex');
  return c.json({ size: bytes?.length, hashMatches });
});
const apiServer = serve({ fetch: req => app.fetch(req, { CORS_ALLOW_ORIGIN: allowedOrigin }), hostname: '127.0.0.1', port: 0 });
servers.push(apiServer); if (!apiServer.listening) await once(apiServer, 'listening');
apiOrigin = `http://127.0.0.1:${apiServer.address().port}`;
async function createFixture(role) {
  const id = randomUUID(), base = `cors-acceptance/${id}`;
  const fixture = { id, role, putKey: `${base}/single.mp4`, wrongKey: `${base}/wrong.mp4`, multipartKey: `${base}/multipart.mp4`, completed: false };
  fixtures.set(id, fixture);
  const put = await presignR2Put(env, fixture.putKey, 'video/mp4', 31);
  const wrongType = await presignR2Put(env, fixture.wrongKey, 'video/mp4', 31);
  const parts = [];
  if (role === 'allowed') {
    fixture.uploadId = await createR2MultipartUpload(env, fixture.multipartKey, 'video/mp4');
    const definitions = [{ size: 5 * 1024 * 1024, value: 19 }, { size: 37, value: 23 }];
    fixture.expected = Buffer.concat(definitions.map(part => Buffer.alloc(part.size, part.value)));
    for (let index = 0; index < definitions.length; index++) parts.push({ ...definitions[index],
      url: await presignR2UploadPart(env, fixture.multipartKey, fixture.uploadId, index + 1, 'video/mp4', definitions[index].size) });
  }
  return { id, api: apiOrigin + prefix, mcp: apiOrigin + '/api/mcp', put, wrongType, parts, expectedSize: fixture.expected?.length };
}
async function persistReport() {
  const deniedApiPost = trace.some(row => row.layer === 'api' && row.origin === deniedOrigin && row.method === 'POST' && row.operation === '/fixture/write');
  const deniedStoragePut = trace.some(row => row.layer === 'storage' && row.role === 'denied' && row.method === 'PUT');
  const deniedStoragePreflight = trace.some(row => row.layer === 'storage' && row.role === 'denied' && row.method === 'OPTIONS' && row.status >= 400);
  const complete = results.allowed?.rows.length === 10 && results.denied?.rows.length === 5;
  const report = { measuredAt: new Date().toISOString(), complete, allPassed: complete && Object.values(results).every(result => result.rows.every(row => row.passed)) &&
    !deniedApiPost && !deniedStoragePut && deniedStoragePreflight,
    origins: { allowed: allowedOrigin, denied: deniedOrigin, api: apiOrigin, storage: proxyOrigin },
    scope: 'Actual Hono CORS middleware and Garage storage adapters; synthetic cookie/challenge routes, not full Better Auth/OAuth or production TLS acceptance',
    serverChecks: { deniedApiPostAbsent: !deniedApiPost, deniedStoragePutAbsent: !deniedStoragePut, deniedStoragePreflightObserved: deniedStoragePreflight },
    results, trace };
  await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n');
}
function pageServer(role) {
  return createServer((req, res) => {
    void (async () => {
      const path = new URL(req.url, 'http://fixture').pathname;
      if (path === `${prefix}/fixtures` && req.method === 'POST') { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(await createFixture(role))); return; }
      if (path === `${prefix}/results` && req.method === 'POST') {
        const chunks = []; for await (const chunk of req) chunks.push(chunk);
        const input = JSON.parse(Buffer.concat(chunks).toString());
        results[role] = { origin: input.origin, browser: input.browser, rows: input.rows.map(row => ({
          name: row.name, passed: row.passed === true, ...(Number.isInteger(row.status) ? { status: row.status } : {}),
          ...Object.fromEntries(['etagReadable', 'challengeReadable', 'browserBlocked', 'hashMatches'].filter(key => row[key] === true).map(key => [key, true])),
          ...(Number.isInteger(row.parts) ? { parts: row.parts } : {}), ...(Number.isInteger(row.size) ? { size: row.size } : {}),
        })) };
        await persistReport(); res.end('recorded'); return;
      }
      if (path === `${prefix}/client.js`) { res.setHeader('content-type', 'text/javascript'); res.end(clientJs); return; }
      if (path !== prefix + '/') { res.writeHead(404); res.end(); return; }
      res.setHeader('content-type', 'text/html');
      res.end(`<!doctype html><html lang="en"><title>CORS acceptance: ${role}</title><body data-role="${role}" data-prefix="${prefix}"><h1>CORS acceptance: ${role}</h1><p>Actual browser origin: ${role === 'allowed' ? allowedOrigin : deniedOrigin}</p><button>Run checks</button><pre>Not run</pre><script type="module" src="${prefix}/client.js"></script></body></html>`);
    })().catch(() => { res.writeHead(500); res.end('Fixture request failed'); });
  });
}
allowedOrigin = await listen(pageServer('allowed')); deniedOrigin = await listen(pageServer('denied'));
// Configure only the explicitly isolated fixture bucket, using the existing worker SDK.
const python = process.env.CORS_ACCEPTANCE_PYTHON ?? fileURLToPath(new URL('../../worker/.venv/bin/python', import.meta.url));
execFileSync(python, ['-c', `import boto3,sys\nclient=boto3.client('s3',endpoint_url=sys.argv[1],region_name='garage',aws_access_key_id='GK00000000000000000000000000000000',aws_secret_access_key='0'*64)\nclient.put_bucket_cors(Bucket='videoq-cors-acceptance',CORSConfiguration={'CORSRules':[{'AllowedOrigins':[sys.argv[2]],'AllowedMethods':['GET','HEAD','PUT'],'AllowedHeaders':['*'],'ExposeHeaders':['ETag'],'MaxAgeSeconds':0}]})`, storage, allowedOrigin]);
console.log(JSON.stringify({ allowed: allowedOrigin + prefix + '/', denied: deniedOrigin + prefix + '/', reportPath }));
let stopping = false;
async function shutdown() {
  if (stopping) return; stopping = true;
  for (const fixture of fixtures.values()) {
    if (fixture.uploadId && !fixture.completed) await abortR2MultipartUpload(env, fixture.multipartKey, fixture.uploadId).catch(() => {});
    for (const key of [fixture.putKey, fixture.wrongKey, fixture.multipartKey]) await deleteR2Object(env, key).catch(() => {});
  }
  await Promise.all(servers.map(server => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); })));
}
process.once('SIGTERM', () => { void shutdown(); }); process.once('SIGINT', () => { void shutdown(); });
