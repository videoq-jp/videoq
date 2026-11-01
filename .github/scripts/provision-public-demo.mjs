// The dedicated account is permanent. Only original fixture videos go through
// normal upload/processing APIs; transcripts, scenes and embeddings are never seeded.
import { createRequire } from 'node:module';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { readFile, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const require = createRequire(new URL('../operations-tools/package.json', import.meta.url));
const { Client } = require('pg');
const { hashPassword } = await import(require.resolve('better-auth/crypto'));
const { ORIGIN, SLUG, OWNER, ANSWERS, verifyOwner, verifyCourse } = createRequire(import.meta.url)('./public-demo-policy.cjs');
const operation = process.env.OPERATION || 'audit';
if (!['audit','provision'].includes(operation) || process.env.GITHUB_REF !== 'refs/heads/main' || process.env.GITHUB_REPOSITORY !== 'videoq-jp/videoq') throw new Error('MAIN_ONLY_DEMO_OPERATION');
const db = new Client({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 15_000, statement_timeout: 30_000, application_name: 'videoq-public-demo-setup' });
let connected = false;
let stage = 'fixture-check', cookie = '', directory, report, owner;
const request = (path, options = {}) => fetch(ORIGIN+path, { ...options, redirect: 'error', signal: AbortSignal.timeout(30_000) });
try {
  const root = new URL('../../apps/demo-video/', import.meta.url);
  const material = JSON.parse(await readFile(new URL('content/course.json',root),'utf8'));
  if (material.slug !== SLUG || material.lessons.map(l=>l.key).join(',') !== 'japanese,math,science,social,english') throw new Error('UNREVIEWED_DEMO_MATERIAL');
  const marker = `[${SLUG}]`, description = `${marker} ${material.description}`;
  const descriptions = [];
  for (const lesson of material.lessons) {
    const bytes = await readFile(new URL(`public/lessons/${lesson.key}.mp4`,root));
    if (bytes.length < 1000 || bytes.length > 1_000_000) throw new Error('UNEXPECTED_DEMO_VIDEO_SIZE');
    descriptions.push(`${marker} ${lesson.key} sha256:${createHash('sha256').update(bytes).digest('hex')}`);
  }
  stage = 'inspect-dedicated-owner';
  await db.connect(); connected = true;
  // Locks only this operator, including retries; a transaction protects identity checks.
  await db.query(operation === 'audit' ? 'BEGIN READ ONLY' : 'BEGIN');
  await db.query("SELECT pg_advisory_xact_lock(hashtext('videoq-public-demo-v1'))");
  const matches = await db.query('SELECT id,username,email,name,role,quota_source,is_over_quota,ai_answers_limit,used_ai_answers FROM videoq_security.demo_users WHERE username=$1 OR email=$2',[OWNER.username,OWNER.email]);
  if (matches.rows.length > 1) throw new Error('DEMO_OWNER_COLLISION');
  owner = matches.rows[0]; verifyOwner(owner);
  const target = await db.query('SELECT id,user_id,description FROM videoq_security.demo_courses WHERE lower(share_slug)=lower($1)',[SLUG]);
  verifyCourse(target.rows[0],owner,description);
  if (owner) {
    const foreign = await db.query('SELECT (SELECT count(*) FROM videoq_security.demo_videos WHERE user_id=$1 AND (description IS NULL OR NOT (description = ANY($2::text[])))) + (SELECT count(*) FROM videoq_security.demo_courses WHERE user_id=$1 AND description IS DISTINCT FROM $3) AS count',[owner.id,descriptions,description]);
    if (Number(foreign.rows[0].count)) throw new Error('DEMO_OWNER_HAS_UNRELATED_CONTENT');
  }
  if (operation === 'audit') {
    await db.query('ROLLBACK');
    report = { status:'public_demo_audit', readOnly:true, ownerPresent:!!owner, coursePresent:!!target.rows[0], monthlyAnswerLimit:owner?.ai_answers_limit ?? null, requestedMonthlyAnswerLimit:ANSWERS };
  } else {
    stage = 'prepare-dedicated-owner';
    const password = randomBytes(32).toString('base64url'), hash = await hashPassword(password);
    // Usage counters are deliberately preserved by the scoped database function.
    const ownerId = owner?.id ?? randomUUID();
    await db.query('SELECT videoq_security.demo_prepare($1::uuid,$2)', [ownerId, hash]);
    owner = { id: ownerId, ...OWNER, is_over_quota: false };
    await db.query('COMMIT');
    stage = 'login-dedicated-owner';
    const login = await request('/api/auth/sign-in/email',{method:'POST',headers:{Origin:ORIGIN,'Content-Type':'application/json'},body:JSON.stringify({email:OWNER.email,password})});
    if (!login.ok) throw new Error('DEMO_LOGIN_FAILED');
    cookie = login.headers.getSetCookie().map(value=>value.split(';',1)[0]).join('; ');
    if (!cookie.includes('session_token=')) throw new Error('DEMO_SESSION_MISSING');
    directory = await mkdtemp(join(tmpdir(),'videoq-public-demo-'));
    const cookiePath = join(directory,'cookie'); await writeFile(cookiePath,cookie,{mode:0o600});
    stage = 'register-normal-api-course';
    const result = await new Promise((resolveChild,reject) => {
      const child = spawn(process.execPath,['--import',fileURLToPath(new URL('./public-demo-fetch-guard.mjs',import.meta.url)),resolve('apps/api/scripts/prepare-student-demo.ts'),'--origin',ORIGIN],{env:{...process.env,DATABASE_URL:'',VIDEOQ_DEMO_COOKIE_FILE:cookiePath},stdio:['ignore','pipe','pipe'],signal:AbortSignal.timeout(20*60_000)});
      // Never forward raw API errors, sessions or presigned URLs to Actions logs.
      child.stdout.resume(); child.stderr.resume(); child.on('error',reject); child.on('close',resolveChild);
    });
    if (result !== 0) throw new Error('DEMO_REGISTRATION_FAILED');
    stage = 'verify-published-course';
    const response = await request('/api/trpc/courses.shared?input='+encodeURIComponent(JSON.stringify({slug:SLUG})));
    const course = (await response.json()).result?.data;
    if (!response.ok || course?.videos?.length !== 5 || course.description !== description || course.videos.some(v=>v.status!=='completed')) throw new Error('DEMO_PUBLICATION_NOT_CONFIRMED');
    const indexed = await db.query('SELECT count(DISTINCT video_id) AS count FROM videoq_security.demo_scene_embeddings WHERE user_id=$1 AND video_id = ANY($2::bigint[])',[owner.id,course.videos.map(v=>v.id)]);
    if (Number(indexed.rows[0].count) !== 5) throw new Error('DEMO_INDEXING_NOT_CONFIRMED');
    report = {status:'public_demo_ready',courseId:course.id,videos:5,indexedVideos:5,monthlyAnswerLimit:ANSWERS,sharePath:'/share/'+SLUG};
  }
} catch (error) {
  if (connected) { try { await db.query('ROLLBACK'); } catch {} }
  report = {status:'public_demo_setup_failed',stage,errorType:error.name,...(/^[A-Z0-9_]+$/.test(error.message) ? {reason:error.message} : {})}; process.exitCode=1;
} finally {
  if (cookie) {
    try { await request('/api/auth/sign-out',{method:'POST',headers:{Cookie:cookie,Origin:ORIGIN}}); } catch {}
  }
  if (directory) await rm(directory,{recursive:true,force:true});
  await db.end().catch(()=>{});
}
console.log(JSON.stringify(report));
