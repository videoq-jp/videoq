import { historyForCourse, exportHistoryCsv } from '../src/features/chat/service';
import { teachingConnection } from '../src/features/teaching/service';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import type { AppEnv, Bindings } from '../src/types/bindings';
import { classroomRoutes } from '../src/features/classroom/routes';
import { securityHeaders } from '../src/middleware/security-headers';
import { digest, putCredential } from '../src/features/lti/store';
import { saveAccount, exchangeCode, readAccount } from '../src/features/classroom/oauth';
import { getCourseWithMembers } from '../src/repositories/chat-repository';
import { getVideoEvidence } from '../src/repositories/video-evidence-repository';
import { readCourseHistory } from '../src/features/lti/history';
import { sendChatMessage } from '../src/features/chat/message-service';
import { classroomVideoSummaries, classroomPlaybackVideo } from '../src/features/classroom/repository';
import { resolveFileUrl } from '../src/integrations/media';
import { materialUri } from '../src/features/classroom/authorization';
import { classroomConfig } from '../src/features/classroom/config';

vi.mock('../src/features/chat/service', () => ({ historyForCourse: vi.fn(), exportHistoryCsv: vi.fn() }));
vi.mock('../src/features/teaching/service', () => ({ teachingConnection: vi.fn(), issueTeachingTicket: vi.fn() }));
const records = vi.hoisted(() => new Map<string, { kind: string; payload: Record<string, unknown> }>());
vi.mock('../src/features/lti/store', async original => ({
  ...await original<typeof import('../src/features/lti/store')>(),
  putCredential: vi.fn((_env, id, kind, payload) => { records.set(id, { kind, payload }); }),
  readCredential: vi.fn((_env, id, kind) => records.get(id)?.kind === kind ? records.get(id)!.payload : null),
  replaceCredentialPayload: vi.fn((_env, id, kind, payload) => { if (records.get(id)?.kind !== kind) return false;records.set(id, { kind, payload });return true; }),
  consumeCredential: vi.fn((_env, id, kind) => records.get(id)?.kind === kind && records.delete(id)),
  recordScopeVideos: vi.fn((_env, id, ids) => { const row = records.get(id); if (!row) return null;
    const result = [...new Set([...(row.payload.scopeVideoIds as number[] ?? []), ...ids])];row.payload.scopeVideoIds = result;return result; }),
}));
vi.mock('../src/features/classroom/oauth', async original => ({
  ...await original<typeof import('../src/features/classroom/oauth')>(), exchangeCode: vi.fn(),
}));
vi.mock('../src/repositories/chat-repository', () => ({ getCourseWithMembers: vi.fn(), updateChatLogFeedback: vi.fn() }));
vi.mock('../src/integrations/media', async original => ({ ...await original<typeof import('../src/integrations/media')>(), resolveFileUrl: vi.fn() }));
vi.mock('../src/features/classroom/repository', () => ({ classroomVideoSummaries: vi.fn(), classroomPlaybackVideo: vi.fn() }));
vi.mock('../src/repositories/video-evidence-repository', () => ({ getVideoEvidence: vi.fn() }));
vi.mock('../src/features/lti/history', () => ({ readCourseHistory: vi.fn(async () => []), appendCourseHistory: vi.fn() }));
vi.mock('../src/features/chat/message-service', () => ({ sendChatMessage: vi.fn(), streamChatMessage: vi.fn() }));
const config = { toolOrigin: 'https://api.example' };
const env = { CLASSROOM_CONFIG: JSON.stringify(config), CLASSROOM_CLIENT_ID: 'classroom-client', CLASSROOM_CLIENT_SECRET: 'secret',
  USER_SECRET_ENCRYPTION_KEY: 'A'.repeat(43) } as Bindings;
const app = new Hono<AppEnv>();app.use('*', securityHeaders);app.route('/api/classroom', classroomRoutes);
const discovery = { courseId: 'google-course', itemId: 'post', itemType: 'courseWork', view: 'discovery', addOnToken: 'add-on-secret' };
const student = { courseId: 'google-course', itemId: 'post', itemType: 'courseWork', view: 'student', attachmentId: 'attachment' };
let teacher = true, apiDenied = false, attachmentChanged = false;
let googleFetch: ReturnType<typeof vi.spyOn>;
function request(path: string, body: unknown, token?: string, origin = config.toolOrigin, bindings = env) {
  return app.request(config.toolOrigin + '/api/classroom/' + path, { method: 'POST',
    headers: { Origin: origin, 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
    body: JSON.stringify(body) }, bindings);
}
async function account(subject = 'google-user') {
  return saveAccount(env, { subject, clientId: env.CLASSROOM_CLIENT_ID, accessToken: 'google-access-secret',
    refreshToken: 'google-refresh-secret', expiresAt: Date.now() + 3600_000 });
}
async function session(launch = student) {
  const token = await account();const res = await request('session', { launch }, token);
  expect(res.status).toBe(200);return (await res.json<{ token: string }>()).token;
}
beforeEach(() => {
  vi.clearAllMocks();records.clear();
  vi.mocked(teachingConnection).mockImplementation(async (_env, _provider, _installation, context) => context === 'google-course' ? { id: 'lesson', provider: 'classroom', installationId: 'classroom-client', contextId: context, teacherSubject: 'google-user', ownerUserId: 'owner', courseId: 12, courseTitle: '数学の動画', active: true, createdAt: new Date() } : null);
teacher = true;apiDenied = attachmentChanged = false;
  vi.mocked(getCourseWithMembers).mockResolvedValue({ id: 12, userId: 'owner', memberVideoIds: [1] });
  vi.mocked(classroomPlaybackVideo).mockResolvedValue({ title: '動画', description: '教材の説明', file: 'video.mp4', sourceType: 'file', youtubeId: '' });
  vi.mocked(resolveFileUrl).mockResolvedValue('https://media.example/signed.mp4');
  vi.mocked(classroomVideoSummaries).mockResolvedValue([{ id: 1, title: '動画' }]);
  vi.mocked(getVideoEvidence).mockResolvedValue({ id: 1, title: '動画', sourceType: 'file', fileKey: 'video.mp4', transcript: '字幕', transcriptTooLarge: false });
  vi.mocked(sendChatMessage).mockResolvedValue({ status: 200, body: { role: 'assistant', answer: { segments: [{ text: '回答', sourceIds: [] }], sources: [] }, chat_log_id: null } });
  googleFetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    expect(url.origin).toBe('https://classroom.googleapis.com');
    expect((init!.headers as Record<string, string>).Authorization).toBe('Bearer google-access-secret');
    if (apiDenied) return Response.json({}, { status: 403 });
    if (url.pathname.endsWith('/addOnContext')) return Response.json({ courseId: 'google-course', itemId: 'post',
      ...(teacher ? { teacherContext: {} } : { studentContext: {} }) });
    return Response.json({ id: 'attachment', title: '数学', teacherViewUri: { uri: materialUri(config, 'teacher', 'lesson') },
      studentViewUri: { uri: materialUri(config, 'student', attachmentChanged ? 'other-lesson' : 'lesson') } });
  });
});
describe('Classroom add-on', () => {
  it('uses native owner history and CSV, rejecting learners and co-teachers after fresh checks', async () => {
    vi.mocked(historyForCourse).mockResolvedValue({count:0,results:[]});
    vi.mocked(exportHistoryCsv).mockResolvedValue({body:new ReadableStream({start(controller){controller.enqueue(new TextEncoder().encode('question,answer\r\n'));controller.close();}}),filename:'history.csv'});
    const token = await session();
    expect((await request('materials',{},token)).status).toBe(200);
    expect((await request('course-history',{action:'list'},token)).status).toBe(200);
    expect(historyForCourse).toHaveBeenCalledWith(env,12,'owner',100,0);
    const csv = await request('course-history',{action:'csv'},token);
    expect(csv.headers.get('Content-Type')).toContain('text/csv');
    expect(await csv.text()).toContain('question,answer');
    teacher = false;
    expect((await request('course-history',{action:'list'},token)).status).toBe(403);
    teacher = true;
    const connected = await teachingConnection(env,'classroom','classroom-client','google-course');
    vi.mocked(teachingConnection).mockResolvedValue({...connected!,teacherSubject:'another-teacher'});
    expect((await request('course-history',{action:'list'},token)).status).toBe(403);
  });
  it('is disabled without explicit configuration', async () => {
    expect((await app.request('https://api.example/api/classroom/discovery', {}, {})).status).toBe(404);
  });
  it('accepts only installation configuration and rejects the removed static mappings', () => {
    expect(classroomConfig(env)).toEqual(config);
    expect(() => classroomConfig({ ...env, CLASSROOM_CONFIG: JSON.stringify({ ...config, courses: [] }) })).toThrow();
    expect(() => classroomConfig({ ...env, CLASSROOM_CONFIG: JSON.stringify({ ...config, toolOrigin: 'http://api.example' }) })).toThrow();
  });
  it('frames only nonce-protected Classroom HTML and rejects duplicate launch parameters', async () => {
    const query = new URLSearchParams(discovery);
    const response = await app.request('https://api.example/api/classroom/discovery?' + query.toString(), {}, env);
    expect(response.status).toBe(200);expect(response.headers.get('X-Frame-Options')).toBeNull();
    expect(response.headers.get('Content-Security-Policy')).toContain('frame-ancestors https://classroom.google.com');
    expect(response.headers.get('Referrer-Policy')).toBe('no-referrer');expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect((await app.request('https://api.example/api/classroom/discovery?' + query.toString() + '&courseId=other', {}, env)).status).toBe(400);
  });
  it.each(['courseWork', 'announcements', 'courseWorkMaterials'])('creates content attachments for %s only after Google verifies the teacher', async itemType => {
    const token = await account(), launch = { ...discovery, itemType };
    const response = await request('attachments', { launch, materialId: 'lesson' }, token);
    expect(response.status).toBe(201);
    const create = googleFetch.mock.calls.find(([, init]) => init?.method === 'POST')!;
    expect(String(create[0])).toContain('/' + itemType + '/post/addOnAttachments?addOnToken=add-on-secret');
    expect(JSON.parse(String(create[1]!.body))).toEqual({ title: '数学の動画',
      teacherViewUri: { uri: 'https://api.example/api/classroom/teacher?material=lesson' },
      studentViewUri: { uri: 'https://api.example/api/classroom/student?material=lesson' } });
  });
  it('refuses student discovery, unknown material, cross-origin writes and unconfigured courses', async () => {
    const token = await account();teacher = false;
    expect((await request('catalog', { launch: discovery }, token)).status).toBe(403);
    teacher = true;
    expect((await request('attachments', { launch: discovery, materialId: 'private' }, token)).status).toBe(403);
    expect((await request('catalog', { launch: discovery }, token, 'https://evil.example')).status).toBe(403);
    vi.mocked(teachingConnection).mockResolvedValueOnce(null);
    const unconnected = await request('catalog', { launch: discovery }, token);
    expect(unconnected.status).toBe(200);expect(await unconnected.json()).toEqual({ connected: false, materials: [] });
  });
  it('encrypts Google tokens at rest and binds login_hint to the verified subject', async () => {
    const token = await account();
    const stored = JSON.stringify(records.get(await digest(token)));
    expect(stored).not.toContain('google-access-secret');expect(stored).not.toContain('google-refresh-secret');
    expect((await request('session', { launch: { ...student, login_hint: 'other-user' } }, token)).status).toBe(403);
  });
  it('creates a scoped student session, retrieves subtitles and passes only authorized videos to chat', async () => {
    teacher = false;const token = await session();
    const stored = records.get(await digest(token))!.payload;
    expect(stored.transport).toBe('classroom');expect(JSON.stringify(stored)).not.toContain('accountToken');
    const transcript = await request('transcript', { videoId: 1 }, token);expect(transcript.status).toBe(200);
    expect((await request('transcript', { videoId: 2 }, token)).status).toBe(403);
    expect((await request('messages', { messages: [{ role: 'user', content: '説明して' }] }, token)).status).toBe(200);
    expect(sendChatMessage).toHaveBeenCalledWith(env, expect.objectContaining({ ltiCourseGrant: 12, ltiVideoGrant: [1], userId: null }));
    expect((await request('materials', {}, token)).status).toBe(200);
    expect(await (await request('materials', {}, token)).json()).toMatchObject({ permissions: { manageContent: false, moderateQa: false, viewTranscript: true } });
  });
  it('rechecks Google authority on every operation, including history', async () => {
    const token = await session();apiDenied = true;
    expect((await request('history', {}, token)).status).toBe(403);
    expect((await request('messages', { messages: [{ role: 'user', content: 'hello' }] }, token)).status).toBe(403);
    expect(readCourseHistory).not.toHaveBeenCalled();expect(sendChatMessage).not.toHaveBeenCalled();
  });
  it('rejects altered/deleted attachments, removed course membership and changed configuration', async () => {
    const token = await session();attachmentChanged = true;
    expect((await request('materials', {}, token)).status).toBe(403);
    attachmentChanged = false;vi.mocked(getCourseWithMembers).mockResolvedValue({ id: 12, userId: 'owner', memberVideoIds: [] });
    const empty = await request('materials', {}, token);expect(empty.status).toBe(200);
    expect(await empty.json()).toMatchObject({learningAvailable:false,videos:[]});
    vi.mocked(getCourseWithMembers).mockResolvedValueOnce(null);
    expect((await request('materials', {}, token)).status).toBe(403);
    const changed = { ...env, CLASSROOM_CONFIG: JSON.stringify({ ...config, toolOrigin: 'https://changed.example' }) };
    expect((await request('history', {}, token, config.toolOrigin, changed)).status).toBe(403);
  });
  it('keeps empty linked courses available for Q&A and owner history while disabling AI playback', async () => {
    vi.mocked(getCourseWithMembers).mockResolvedValue({id:12,userId:'owner',memberVideoIds:[]});
    vi.mocked(classroomVideoSummaries).mockResolvedValue([]);
    const accountToken = await account();
    const catalog = await request('catalog',{launch:discovery},accountToken);
    expect(await catalog.json()).toMatchObject({connected:true,materials:[{id:'lesson'}]});
    const response = await request('session',{launch:student},accountToken);
    expect(response.status).toBe(200);
    const data = await response.json<{token:string;learningAvailable:boolean;playback?:unknown}>();
    expect(data.learningAvailable).toBe(false);expect(data.playback).toBeUndefined();
    expect(await (await request('materials',{},data.token)).json()).toMatchObject({courseHistoryAvailable:true,learningAvailable:false,videos:[],permissions:{viewQa:true}});
    expect((await request('messages',{messages:[{role:'user',content:'Question'}]},data.token)).status).toBe(403);
    expect(sendChatMessage).not.toHaveBeenCalled();
  });
  it('disconnects account credentials and immediately invalidates its learning sessions', async () => {
    const accountToken = await account();const response = await request('session', { launch: student }, accountToken);
    const { token } = await response.json<{ token: string }>();
    expect((await request('disconnect', {}, accountToken)).status).toBe(200);
    expect((await request('history', {}, token)).status).toBe(403);
    expect((await request('session', { launch: student }, accountToken)).status).toBe(401);
  });
  it('does not accept LTI/native credentials through Classroom', async () => {
    const token = await session();
    const payload = { ...records.get(await digest(token))!.payload, transport: 'native' };
    await putCredential(env, await digest(token), 'session', payload, 3600);
    expect((await request('history', {}, token)).status).toBe(401);
  });
  it('uses PKCE, nonce, state and a secure popup cookie, and atomically prevents callback replay', async () => {
    const start = await request('oauth/start', { teacher: true, loginHint: 'google-user' });
    expect(start.status).toBe(200);const url = new URL((await start.json<{ url: string }>()).url);
    expect(url.origin).toBe('https://accounts.google.com');expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('login_hint')).toBe('google-user');expect(url.searchParams.get('scope')).toContain('classroom.addons.teacher');
    const cookie = start.headers.get('Set-Cookie')!;expect(cookie).toContain('Secure');expect(cookie).toContain('HttpOnly');expect(cookie).toContain('SameSite=Lax');
    const state = url.searchParams.get('state')!, nonce = url.searchParams.get('nonce')!;
    vi.mocked(exchangeCode).mockResolvedValue({ subject: 'google-user', clientId: 'classroom-client', accessToken: 'new-secret', expiresAt: Date.now() + 3600_000 });
    const callback = () => app.request('https://api.example/api/classroom/oauth/callback?state=' + state + '&code=code', { headers: { Cookie: cookie.split(';')[0] } }, env);
    const missingCookie = await app.request('https://api.example/api/classroom/oauth/callback?state=' + state + '&code=code', {}, env);
    expect(await missingCookie.text()).toContain('accountToken:null');expect(exchangeCode).not.toHaveBeenCalled();
    expect(await (await callback()).text()).toContain('ログインしました');
    expect(exchangeCode).toHaveBeenCalledWith(env, config, 'code', expect.stringMatching(/^[a-f0-9]{64}$/), nonce, 'google-user');
    expect(await (await callback()).text()).toContain('accountToken:null');expect(exchangeCode).toHaveBeenCalledTimes(1);
  });
});

it('refreshes encrypted credentials once, keeps the original account handle, and stops after disconnect', async () => {
  const accountToken = await saveAccount(env, { subject: 'google-user', clientId: 'classroom-client', accessToken: 'expired', refreshToken: 'refresh', expiresAt: Date.now() - 1 });
  googleFetch.mockResolvedValue(Response.json({ access_token: 'fresh-access', expires_in: 3600 }));
  expect((await readAccount(env, accountToken)).accessToken).toBe('fresh-access');
  expect((await readAccount(env, accountToken)).accessToken).toBe('fresh-access');
  expect(googleFetch).toHaveBeenCalledTimes(1);
  expect(JSON.stringify(records.get(await digest(accountToken)))).not.toContain('fresh-access');
  await request('disconnect', {}, accountToken);
  await expect(readAccount(env, accountToken)).rejects.toThrow();
});

it('authorizes a playlist with metadata only and loads transcripts only when explicitly requested', async () => {
  const token = await session();
  expect(getVideoEvidence).not.toHaveBeenCalled();
  expect(classroomVideoSummaries).toHaveBeenCalledWith(env, 'owner', [1]);
  expect((await request('materials', {}, token)).status).toBe(200);
  expect(getVideoEvidence).not.toHaveBeenCalled();
  expect((await request('transcript', { videoId: 1 }, token)).status).toBe(200);
  expect(getVideoEvidence).toHaveBeenCalledTimes(1);
});

it('serves the selected video overview and playback only within the attachment scope', async () => {
  const token = await session();
  expect(await (await request('playback', { videoId: 1 }, token)).json()).toEqual({ kind: 'file', title: '動画', description: '教材の説明', url: 'https://media.example/signed.mp4' });
  expect(classroomPlaybackVideo).toHaveBeenCalledWith(env, 'owner', 1);
  vi.mocked(classroomPlaybackVideo).mockClear();
  expect((await request('playback', { videoId: 2 }, token)).status).toBe(403);
  expect(classroomPlaybackVideo).not.toHaveBeenCalled();
});
it('serves YouTube overviews and fails closed if the selected video is no longer available', async () => {
  const token = await session();
  vi.mocked(classroomPlaybackVideo).mockResolvedValue({ title: 'YouTube教材', description: '授業の説明', file: '', sourceType: 'youtube', youtubeId: 'abcdefghijk' });
  expect(await (await request('playback', { videoId: 1 }, token)).json()).toMatchObject({ kind: 'youtube', title: 'YouTube教材', description: '授業の説明', url: 'https://www.youtube-nocookie.com/embed/abcdefghijk' });
  vi.mocked(classroomPlaybackVideo).mockResolvedValue(null);
  expect((await request('playback', { videoId: 1 }, token)).status).toBe(403);
});
it('takes owner-visible identity from the verified account, never browser input', async () => {
  const accountToken = await saveAccount(env, { subject: 'student-sub', name: 'Student A', email: 'student@school.example',
    clientId: env.CLASSROOM_CLIENT_ID!, accessToken: 'google-access-secret', expiresAt: Date.now() + 3600_000 });
  const response = await request('session', { launch: student }, accountToken);
  expect(response.status).toBe(200);
  const body = await response.json<{ token: string; classroomAuthor?: unknown }>();
  expect(body.classroomAuthor).toBeUndefined();
  const stored = records.get(await digest(body.token))!.payload;
  expect(stored.classroomAuthor).toEqual({ user_id: expect.stringMatching(/^classroom:[a-f0-9]{64}$/), username: 'Student A', email: 'student@school.example' });
  expect((await request('session', { launch: student, classroomAuthor: { username: 'impersonated' } }, accountToken)).status).toBe(400);
});
