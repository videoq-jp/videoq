import { ClassroomAccessDeniedError } from '../../application/classroom';
import { Hono, type Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import { z } from 'zod';
import type { AppEnv } from '../../types/bindings';
import { toErrorBody } from '../../shared/errors';
import { clientIp, enforceThrottles, throttledResponse } from '../../lib/rate-limit';
import { digest, randomSecret, putCredential, readCredential, consumeCredential } from '../lti/store';
import { mountLearningRoutes } from '../lti/learning-routes';
import { questionView, scriptJson } from '../lti/view';
import { classroomConfig, launchSchema } from './config';
import { classroomAuthorizationURL, exchangeCode, readAccount, saveAccount } from './oauth';
import { configFingerprint } from './authorization';
import { classroomWorkflow } from '../../integrations/classroom-workflow';
import { authenticationScript, discoveryScript, page, playerScript, popupScript } from './view';

export const classroomRoutes = new Hono<AppEnv>();
const opaque = z.string().regex(/^[a-f0-9]{64}$/);
function refused(c: Context<AppEnv>, status: 400 | 401 | 403 = 400) {
  return c.json(toErrorBody(status === 401 ? 'UNAUTHORIZED' : 'VALIDATION_ERROR',
    'Classroom access could not be verified. Reopen the add-on from Classroom.'), status);
}
function framePolicy(c: Context<AppEnv>, nonce: string) {
  c.header('Content-Security-Policy', `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; media-src https:; frame-src https://www.youtube-nocookie.com; base-uri 'none'; form-action 'none'; frame-ancestors https://classroom.google.com`);
  c.header('Referrer-Policy', 'no-referrer');
}
classroomRoutes.use('*', bodyLimit({ maxSize: 32 * 1024 }));
classroomRoutes.use('*', async (c: Context<AppEnv>, next) => {
  c.header('Cache-Control', 'no-store');
  const config = classroomConfig(c.env);
  if (!config) return c.json(toErrorBody('NOT_FOUND', 'Classroom is not configured.'), 404);
  const denied = await enforceThrottles(c.env, [{ scope: 'lti_request_ip', ident: 'classroom:' + clientIp(c) }]);
  if (denied) return throttledResponse(c, denied);
  if (c.req.method === 'POST' && c.req.header('Origin') !== config.toolOrigin) return refused(c, 403);
  await next();
});

for (const view of ['discovery', 'teacher', 'student'] as const) {
  classroomRoutes.get('/' + view, c => {
    const params = new URL(c.req.url).searchParams;
    if ([...params.keys()].some(key => params.getAll(key).length > 1)) return refused(c);
    const input = launchSchema.safeParse({ view, ...Object.fromEntries([...params].filter(([key]) =>
      ['courseId', 'itemId', 'itemType', 'attachmentId', 'addOnToken', 'login_hint'].includes(key))) });
    if (!input.success) return refused(c);
    const nonce = randomSecret();framePolicy(c, nonce);
    if (view === 'discovery') return c.html(page(nonce, 'VideoQ の教材を添付',
      '<p id="status" role="status">接続を確認しています…</p><label for="material">教材</label><select id="material" disabled></select><button id="attach" disabled>Classroom に添付</button>', discoveryScript(input.data)));
    return c.html(questionView(nonce, '', '', 'ja', ['https://classroom.google.com'], {
      bootstrapScript: authenticationScript(input.data), playerScript,
    }));
  });
}
classroomRoutes.get('/oauth/popup', c => {
  const nonce = randomSecret();framePolicy(c, nonce);
  return c.html(page(nonce, 'Google でログイン', '<p id="status" role="status">Googleに接続しています…</p>', popupScript));
});
const oauthState = z.object({ verifier: opaque, nonce: opaque, cookieHash: opaque,
  loginHint: z.string().optional(), configHash: opaque });
classroomRoutes.post('/oauth/start', async c => {
  const input = z.object({ loginHint: z.string().min(1).max(255).optional(), teacher: z.boolean() }).strict()
    .safeParse(await c.req.json().catch(() => null));
  if (!input.success) return refused(c);
  const config = classroomConfig(c.env)!;
  const state = randomSecret(), verifier = randomSecret(), nonce = randomSecret(), cookie = randomSecret();
  await putCredential(c.env, state, 'classroom-oauth', { verifier, nonce, cookieHash: await digest(cookie),
    loginHint: input.data.loginHint, configHash: await configFingerprint(c.env, config) }, 300);
  // Top-level popup only: Lax is sufficient for Google's callback; iframe cookies are unused.
  setCookie(c, '__Host-videoq-classroom-' + state, cookie, { httpOnly: true, secure: true, sameSite: 'Lax', path: '/', maxAge: 300 });
  const url = await classroomAuthorizationURL(c.env, config, { state, verifier, nonce,
    teacher: input.data.teacher, loginHint: input.data.loginHint });
  return c.json({ url: url.href });
});
classroomRoutes.get('/oauth/callback', async c => {
  const config = classroomConfig(c.env)!, params = new URL(c.req.url).searchParams;
  const state = params.get('state');
  let accountToken: string | undefined;
  if (opaque.safeParse(state).success && [...params.keys()].every(key => params.getAll(key).length === 1)) {
    const record = oauthState.safeParse(await readCredential(c.env, state!, 'classroom-oauth'));
    const cookieName = '__Host-videoq-classroom-' + state, cookie = getCookie(c, cookieName);
    deleteCookie(c, cookieName, { secure: true, path: '/' });
    if (record.success && cookie && record.data.cookieHash === await digest(cookie)
      && record.data.configHash === await configFingerprint(c.env, config)
      && await consumeCredential(c.env, state!, 'classroom-oauth') && params.get('code') && !params.has('error')) {
      try { accountToken = await saveAccount(c.env, await exchangeCode(c.env, config, params.get('code')!,
        record.data.verifier, record.data.nonce, record.data.loginHint)); } catch { /* No Google tokens/errors in the response or logs. */ }
    }
  }
  const nonce = randomSecret();framePolicy(c, nonce);
  return c.html(page(nonce, accountToken ? 'ログインしました' : 'ログインできませんでした',
    '<p>元のClassroomの画面に戻ってください。</p>',
    `if(window.opener){window.opener.postMessage({type:'videoq:classroom-oauth-result',accountToken:${scriptJson(accountToken ?? null)}},${scriptJson(config.toolOrigin)});window.close();}`));
});
function bearer(c: Context<AppEnv>) { return c.req.header('Authorization')?.match(/^Bearer ([a-f0-9]{64})$/)?.[1]; }
async function accountInput(c: Context<AppEnv>) {
  const token = bearer(c);
  if (!token) return null;
  try { await readAccount(c.env, token);return token; } catch { return null; }
}
classroomRoutes.post('/catalog', async c => {
  const token = await accountInput(c);if (!token) return refused(c, 401);
  const input = z.object({ launch: launchSchema }).strict().safeParse(await c.req.json().catch(() => null));
  if (!input.success || input.data.launch.view !== 'discovery') return refused(c);
  try { const result = await classroomWorkflow(c.env).catalog(input.data.launch, token);return c.json({ connected: !!result.binding, materials: result.materials.map(({ id, title }) => ({ id, title })) }); }
  catch { return refused(c, 403); }
});
classroomRoutes.post('/teacher/connect', async c => {
  const token = await accountInput(c);if (!token) return refused(c, 401);
  const input = z.object({ launch: launchSchema }).strict().safeParse(await c.req.json().catch(() => null));
  if (!input.success || input.data.launch.view === 'student') return refused(c, 403);
  try {
    return c.json(await classroomWorkflow(c.env).connectTeacher(input.data.launch, token));
  } catch { return refused(c, 403); }
});
classroomRoutes.post('/attachments', async c => {
  const token = await accountInput(c);if (!token) return refused(c, 401);
  const input = z.object({ launch: launchSchema, materialId: z.string() }).strict().safeParse(await c.req.json().catch(() => null));
  if (!input.success || input.data.launch.view !== 'discovery') return refused(c);
  try {
    return c.json(await classroomWorkflow(c.env).attach(input.data.launch, token, input.data.materialId), 201);
  } catch { return refused(c, 403); }
});
classroomRoutes.post('/session', async c => {
  const accountToken = await accountInput(c);if (!accountToken) return refused(c, 401);
  const input = z.object({ launch: launchSchema }).strict().safeParse(await c.req.json().catch(() => null));
  if (!input.success || input.data.launch.view === 'discovery') return refused(c);
  const workflow = classroomWorkflow(c.env), identity = await workflow.prepareSession();
  try { return c.json(await workflow.createSession(input.data.launch, accountToken, identity)); }
  catch { return refused(c, 403); }
});
async function authorize(c: Context<AppEnv>) {
  const token = bearer(c);if (!token) return { error: refused(c, 401) } as const;
  const result = await classroomWorkflow(c.env).authorize(token);
  if ('failure' in result) return { error: refused(c, result.failure === 'unauthorized' ? 401 : 403) } as const;
  return result.access;
}

classroomRoutes.post('/disconnect', async c => {
  const token = bearer(c);if (!token) return refused(c, 401);
  await consumeCredential(c.env, await digest(token), 'classroom-account');
  return c.json({ disconnected: true });
});
classroomRoutes.post('/playback', async c => {
  const access = await authorize(c);if ('error' in access) return access.error;
  const input = z.object({ videoId: z.number().int().positive().safe() }).strict().safeParse(await c.req.json().catch(() => null));
  if (!input.success) return refused(c);
  try { return c.json(await classroomWorkflow(c.env).playback(access, input.data.videoId)); }
  catch (error) { if (error instanceof ClassroomAccessDeniedError) return refused(c, 403); throw error; }
});
mountLearningRoutes(classroomRoutes, authorize, refused);
