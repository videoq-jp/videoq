/** Upload the five owned lessons through the real API; never insert transcripts,
 * embeddings, scenes or answers. Use a dedicated demo owner.
 * Local: npm run demo:students --workspace @videoq/api -- --local-user <id> --upload-only
 * Run the normal worker, then repeat without --upload-only to publish the course.
 * Remote: VIDEOQ_DEMO_COOKIE_FILE points to a Cookie header file; --origin HTTPS.
 */
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { setTimeout } from 'node:timers/promises';
import type { ProcedureName, RpcInputMap, RpcOutputMap } from '@videoq/trpc';

const { values } = parseArgs({ options: {
  origin: { type: 'string', default: 'http://127.0.0.1:8787' },
  'local-user': { type: 'string' }, 'upload-only': { type: 'boolean' }, check: { type: 'boolean' },
} });
const origin = new URL(values.origin);
const local = ['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname);
if (origin.pathname !== '/' || origin.username || origin.password || origin.search || origin.hash
  || (!local && origin.protocol !== 'https:') || (!local && values['local-user'])) throw new Error('Invalid origin/auth combination.');
const cookie = process.env.VIDEOQ_DEMO_COOKIE_FILE ? (await readFile(process.env.VIDEOQ_DEMO_COOKIE_FILE, 'utf8')).trim() : '';
if (!values.check && !cookie && !values['local-user']) throw new Error('Provide a dedicated demo owner.');
const headers = { 'Content-Type': 'application/json', Origin: origin.origin,
  ...(cookie ? { Cookie: cookie } : {}), ...(values['local-user'] ? { 'X-VideoQ-Test-User-Id': values['local-user'] } : {}),
};
const demoRoot = new URL('../../demo-video/', import.meta.url);
const course = JSON.parse(await readFile(new URL('content/course.json', demoRoot), 'utf8')) as {
  name: string; slug: string; description: string; lessons: { key: string; title: string; subject: string }[];
};
async function rpc<K extends ProcedureName>(name: K, input: RpcInputMap[K], mutate = false, anonymous = false): Promise<RpcOutputMap[K]> {
  const url = new URL(`/api/trpc/${name}`, origin);
  if (!mutate) url.searchParams.set('input', JSON.stringify(input));
  const response = await fetch(url, { method: mutate ? 'POST' : 'GET', headers: anonymous ? {} : headers,
    ...(mutate ? { body: JSON.stringify(input) } : {}), signal: AbortSignal.timeout(30_000),
  });
  const body = await response.json<{ result?: { data: RpcOutputMap[K] }; error?: { message?: string } }>();
  if (!response.ok || !body.result || body.error) throw new Error(`${name}: ${response.status} ${body.error?.message ?? 'Invalid response'}`);
  return body.result.data;
}
async function listAll<K extends 'videos.list' | 'courses.list'>(name: K) {
  const records: { id: number; description: string }[] = [];
  for (let cursor = 0;;) {
    const page = await rpc(name, { cursor, limit: 100 });
    records.push(...page.data); cursor += page.data.length;
    if (!page.data.length || cursor >= page.meta.total) return records;
  }
}
const marker = `[${course.slug}]`;
if (!values.check) {
  const existing = await listAll('videos.list');
  const ids: number[] = [];
  for (const lesson of course.lessons) {
    const bytes = await readFile(new URL(`public/lessons/${lesson.key}.mp4`, demoRoot));
    const description = `${marker} ${lesson.key} sha256:${createHash('sha256').update(bytes).digest('hex')}`;
    let video = existing.find(item => item.description === description);
    if (!video) {
      const upload = await rpc('videos.requestUpload', {
        filename: `${lesson.key}.mp4`, contentType: 'video/mp4', fileSize: bytes.length, title: lesson.title, description,
      }, true);
      video = upload.video;
      const response = await fetch(upload.upload_url, { method: 'PUT', headers: { 'Content-Type': 'video/mp4' }, body: bytes, signal: AbortSignal.timeout(60_000) });
      if (!response.ok) throw new Error(`Upload failed: ${response.status}`);
      await rpc('videos.confirmUpload', { id: video.id }, true);
    } else if ((await rpc('videos.get', { id: video.id })).status === 'uploading') {
      // A storage timeout can leave a completed PUT awaiting confirmation.
      await rpc('videos.confirmUpload', { id: video.id }, true);
    }
    ids.push(video.id);
    console.log(`${lesson.subject}: video ${video.id}`);
  }
  if (values['upload-only']) {
    console.log(`Uploaded. Process through the normal worker: ${ids.join(' ')}`);
    process.exit(0);
  }
  for (const id of ids) {
    const deadline = Date.now() + 10 * 60_000;
    for (;;) {
      const video = await rpc('videos.get', { id });
      if (video.status === 'completed' && video.transcript?.trim()) break;
      if (video.status === 'error' || Date.now() > deadline) throw new Error(`Video ${id} is not ready: ${video.status}`);
      await setTimeout(5000);
    }
  }
  const courses = await listAll('courses.list');
  let saved = courses.find(item => item.description === `${marker} ${course.description}`);
  if (!saved) saved = await rpc('courses.create', { name: course.name, description: `${marker} ${course.description}` }, true);
  const detail = await rpc('courses.get', { id: saved.id });
  if (detail.videos?.some(video => !ids.includes(video.id))) throw new Error('Course contains other material; left unchanged.');
  if (detail.share_slug && detail.share_slug !== course.slug) throw new Error('Existing share URL was not replaced.');
  for (const id of ids) if (!detail.videos?.some(video => video.id === id)) await rpc('memberships.addVideo', { courseId: saved.id, videoId: id }, true);
  await rpc('courses.createShare', { id: saved.id, shareSlug: course.slug }, true);
}
const published = await rpc('courses.shared', { slug: course.slug }, false, true);
if (published.videos?.length !== 5 || published.videos.some(video => video.status !== 'completed') || !published.description.startsWith(marker)) throw new Error('The five-lesson demo is not ready.');
console.log(JSON.stringify({ courseId: published.id, url: `/share/${course.slug}`, videos: published.videos.map(video => ({ id: video.id, title: video.title })) }, null, 2));
