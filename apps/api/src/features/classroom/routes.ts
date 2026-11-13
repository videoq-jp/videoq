import { Hono, type Context } from 'hono';
import { issueTeachingTicket } from '../teaching/service';
import { bodyLimit } from 'hono/body-limit';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import { z } from 'zod';
import type { AppEnv } from '../../types/bindings';
import { toErrorBody } from '../../shared/errors';
import { clientIp, enforceThrottles, throttledResponse } from '../../lib/rate-limit';
import { encryptServerSecret, decryptServerSecret } from '../../lib/secret-encryption';
import { classroomPlaybackVideo } from './repository';
import { getCourseWithMembers } from '../../repositories/chat-repository';
import { resolveFileUrl } from '../../integrations/media';
import { digest, randomSecret, putCredential, readCredential, consumeCredential } from '../lti/store';
import { mountLearningRoutes } from '../lti/learning-routes';
import { questionView, scriptJson } from '../lti/view';
import { classroomConfig, classroomFeatures, launchSchema, type ClassroomLaunch } from './config';
import { callbackUri, exchangeCode, pkceChallenge, readAccount, saveAccount } from './oauth';
import { authorizeAttachment, classroomAccess, classroomSession, configFingerprint, materialUri } from './authorization';
import { attachmentSchema, googleJson, postUrl } from './client';
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
  const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  const params = { client_id: c.env.CLASSROOM_CLIENT_ID!, redirect_uri: callbackUri(config), response_type: 'code',
    scope: `openid email profile https://www.googleapis.com/auth/classroom.addons.${input.data.teacher ? 'teacher' : 'student'}`,
    state, nonce, code_challenge: await pkceChallenge(verifier), code_challenge_method: 'S256',
    access_type: 'offline', include_granted_scopes: 'true', prompt: input.data.loginHint ? 'consent' : 'select_account consent',
    ...(input.data.loginHint ? { login_hint: input.data.loginHint } : {}) };
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
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
async function catalog(c: Context<AppEnv>, launch: ClassroomLaunch, token: string) {
  const access = await classroomAccess(c.env, launch, token);
  if (!access.context.teacherContext) throw new Error('Teacher required');
  if (!access.binding) return { ...access, materials: [] };
  const course = await getCourseWithMembers(c.env, {
    courseId: access.binding.videoqCourseId, ltiCourseGrant: access.binding.videoqCourseId,
  });
  if (!course) throw new Error('Course unavailable');
  const materials = access.binding.materials.filter(material => material.videoIds.every(id => course.memberVideoIds.includes(id)));
  return { ...access, materials };
}
classroomRoutes.post('/catalog', async c => {
  const token = await accountInput(c);if (!token) return refused(c, 401);
  const input = z.object({ launch: launchSchema }).strict().safeParse(await c.req.json().catch(() => null));
  if (!input.success || input.data.launch.view !== 'discovery') return refused(c);
  try { const result = await catalog(c, input.data.launch, token);return c.json({ connected: !!result.binding, materials: result.materials.map(({ id, title }) => ({ id, title })) }); }
  catch { return refused(c, 403); }
});
classroomRoutes.post('/teacher/connect', async c => {
  const token = await accountInput(c);if (!token) return refused(c, 401);
  const input = z.object({ launch: launchSchema }).strict().safeParse(await c.req.json().catch(() => null));
  if (!input.success || input.data.launch.view === 'student') return refused(c, 403);
  try {
    const access = await classroomAccess(c.env, input.data.launch, token);
    if (!access.context.teacherContext) return refused(c, 403);
    return c.json(await issueTeachingTicket(c.env, { provider: 'classroom', installationId: c.env.CLASSROOM_CLIENT_ID!,
      contextId: input.data.launch.courseId, teacherSubject: access.account.subject,
      teacherName: access.account.name || access.account.email || access.account.subject,
      title: 'Classroom ' + input.data.launch.courseId, returnUrl: 'https://classroom.google.com/',
      classroomProof: { accountEnvelope: await encryptServerSecret(c.env, token, 'teaching-classroom'), launch: input.data.launch } }));
  } catch { return refused(c, 403); }
});
classroomRoutes.post('/attachments', async c => {
  const token = await accountInput(c);if (!token) return refused(c, 401);
  const input = z.object({ launch: launchSchema, materialId: z.string() }).strict().safeParse(await c.req.json().catch(() => null));
  if (!input.success || input.data.launch.view !== 'discovery') return refused(c);
  try {
    const access = await catalog(c, input.data.launch, token);
    const material = access.materials.find(material => material.id === input.data.materialId);
    if (!material) return refused(c, 403);
    const url = postUrl(input.data.launch, 'addOnAttachments');url.searchParams.set('addOnToken', input.data.launch.addOnToken!);
    const result = attachmentSchema.parse(await googleJson(url, access.account.accessToken, {
      title: material.title, teacherViewUri: { uri: materialUri(access.config, 'teacher', material.id) },
      studentViewUri: { uri: materialUri(access.config, 'student', material.id) },
    }));
    return c.json({ attachmentId: result.id }, 201);
  } catch { return refused(c, 403); }
});
classroomRoutes.post('/session', async c => {
  const accountToken = await accountInput(c);if (!accountToken) return refused(c, 401);
  const input = z.object({ launch: launchSchema }).strict().safeParse(await c.req.json().catch(() => null));
  if (!input.success || input.data.launch.view === 'discovery') return refused(c);
  const token = randomSecret(), sessionHash = await digest(token);
  try {
    const access = await authorizeAttachment(c.env, input.data.launch, accountToken, sessionHash);
    await putCredential(c.env, sessionHash, 'session', { ...access.grant, classroomAuthor: access.classroomAuthor, classroom: {
      launch: input.data.launch, materialId: access.materialId,
      accountEnvelope: await encryptServerSecret(c.env, accountToken, `classroom-session:${sessionHash}`),
    } }, 3600);
    return c.json({ token, materialTitle: access.materialTitle, expiresIn: 3600, features: classroomFeatures, learningAvailable: access.current!.videos.length > 0,
      ...(access.current!.videos.length ? { playback: { videoId: access.current!.videos[0].videoId, videos: access.current!.videos, parentOrigins: [] } } : {}) });
  } catch { return refused(c, 403); }
});
async function authorize(c: Context<AppEnv>) {
  const token = bearer(c);if (!token) return { error: refused(c, 401) } as const;
  const sessionHash = await digest(token);
  const stored = classroomSession.safeParse(await readCredential(c.env, sessionHash, 'session'));
  if (!stored.success) return { error: refused(c, 401) } as const;
  try {
    const config = classroomConfig(c.env)!;
    if (stored.data.registrationHash !== await configFingerprint(c.env, config)) return { error: refused(c, 403) } as const;
    const accountToken = await decryptServerSecret(c.env, stored.data.classroom.accountEnvelope, `classroom-session:${sessionHash}`);
    const access = await authorizeAttachment(c.env, stored.data.classroom.launch, accountToken, sessionHash);
    if (access.materialId !== stored.data.classroom.materialId || access.grant.subjectHash !== stored.data.subjectHash
      || access.grant.courseId !== stored.data.courseId) return { error: refused(c, 403) } as const;
    // Preserve accumulated scope so the shared chat code can detect scope shrinkage.
    return { ...access, grant: { ...access.grant, scopeVideoIds: stored.data.scopeVideoIds } };
  } catch { return { error: refused(c, 403) } as const; }
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
  const videoId = input.data.videoId;
  if (!access.current!.videos.some(video => video.videoId === videoId)) return refused(c, 403);
  const video = await classroomPlaybackVideo(c.env, access.course!.userId, videoId);
  if (!video) return refused(c, 403);
  if (video.sourceType === 'youtube' && /^[A-Za-z0-9_-]{11}$/.test(video.youtubeId))
    return c.json({ kind: 'youtube', title: video.title, description: video.description, url: `https://www.youtube-nocookie.com/embed/${video.youtubeId}` });
  const url = await resolveFileUrl(c.env, video.file);
  if (!url || !url.startsWith('https://')) return refused(c, 403);
  return c.json({ kind: 'file', title: video.title, description: video.description, url });
});
mountLearningRoutes(classroomRoutes, authorize, refused);
