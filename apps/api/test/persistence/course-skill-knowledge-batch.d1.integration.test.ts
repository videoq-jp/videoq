import { expect, it } from 'vitest';
import { createD1Fixture } from './d1-fixture';
import { createCourseSkillInputRepository, createCourseSkillInputs } from '../../src/integrations/course-skill-inputs';
import { generateAndSaveCourseSkillCandidates } from '../../src/integrations/course-skill-candidates';
import type { Bindings } from '../../src/types/bindings';

it('loads 905 knowledge chunks in bounded queries without changing model input order', async () => {
  const fixture = await createD1Fixture();
  const db = fixture.database;
  const sql = async (text: string, args: (string | number)[] = []) => { await db.prepare(text).bind(...args).run(); };
  const env = { DB: db, PERSISTENCE_BACKEND: 'd1', DEPLOYMENT_EDITION: 'cloud', LLM_MODEL: 'fixture', TASK_SCHEDULER: { getByName: () => ({ armAt: async () => undefined }) } } as unknown as Bindings;
  try {
    await sql("INSERT INTO users(id,username,email,is_over_quota,used_ai_answers,used_processing_seconds,used_storage_bytes) VALUES('owner','owner','owner@example.test',0,0,0,0)");
    await sql("INSERT INTO video_courses(id,user_id,name,description,created_at,updated_at,display_order) VALUES(1,'owner','Course','','2026-11-28','2026-11-28',0)");
    await sql("INSERT INTO videos(id,user_id,title,file,status,transcript,description,uploaded_at,error_message,source_type,source_url,youtube_video_id) VALUES(1,'owner','Synthetic','file.mp4','completed',?,'','2026-11-28','','uploaded','','')", ['1\n00:00:01,000 --> 00:00:02,000\nSynthetic evidence.']);
    await sql("INSERT INTO video_course_members(course_id,video_id,added_at,\"order\") VALUES(1,1,'2026-11-28',0)");
    await (await createCourseSkillInputs(env)).configure(1, 'owner', { generationEnabled: true, distributionEnabled: false, language: 'en', policyVersion: '1' });
    const inputs = await createCourseSkillInputRepository(env);
    const snapshot = (await inputs.snapshot(1, 'owner'))!;
    const job = await db.prepare('SELECT id FROM course_skill_builds').first<{ id: string }>();
    const claim = (await inputs.claim(job!.id, 'owner', 'lease', Date.now(), 60_000))!;
    const keys = Array.from({ length: 905 }, (_, i) => `key-${904 - i}`);
    for (let offset = 0; offset < keys.length; offset += 80) {
      await db.batch(keys.slice(offset, offset + 80).map(key => {
        const index = Number(key.slice(4));
        const chunk = { version: 1, videoId: 1, analysisRevision: snapshot.sources[0].analysisRevision, chunkIndex: index,
          cues: [{ id: `cue-${index}`, startMs: 1000, endMs: 2000, text: 'Synthetic evidence.' }],
          facts: [{ id: `fact-${index}`, kind: 'principle', claim: `Synthetic claim ${index}`, evidence: [{ cueId: `cue-${index}`, quote: 'Synthetic evidence.' }], requiresVisualEvidence: false, status: 'supported', appliesWhen: [], exceptions: [], versionContext: { language: null, framework: null, version: null } }], model: 'fixture', promptVersion: 'fixture' };
        return db.prepare('INSERT INTO course_skill_knowledge_chunks(key,owner_id,video_id,content) VALUES(?,?,?,?)').bind(key, 'owner', 1, JSON.stringify(chunk));
      }));
    }
    const queries: string[] = [], bindingCounts: number[] = [];
    const measured = new Proxy(db, { get(target, key) {
      if (key === 'prepare') return (text: string) => {
        queries.push(text);
        const statement = target.prepare(text);
        return new Proxy(statement, { get(prepared, method) {
          if (method === 'bind') return (...args: unknown[]) => { bindingCounts.push(args.length); return prepared.bind(...args); };
          const value = Reflect.get(prepared, method, prepared);
          return typeof value === 'function' ? value.bind(prepared) : value;
        } });
      };
      const value = Reflect.get(target, key, target);
      return typeof value === 'function' ? value.bind(target) : value;
    } });
    const modelClaims: string[] = [];
    const result = await generateAndSaveCourseSkillCandidates({ ...env, DB: measured }, {
      lease: { id: claim.id, ownerId: 'owner', token: 'lease', generation: claim.generation }, courseId: 1, language: 'en', generationEpoch: snapshot.generationEpoch,
      knowledgeKeys: [...keys, keys[0]],
    }, async (_bindings, _owner, options) => {
      expect(options.name).toBe('skill_task_plan');
      modelClaims.push(...(options.input as { facts: { claim: string }[] }).facts.map(f => f.claim));
      return options.schema.parse({ proposals: [], issues: [] });
    });
    expect(modelClaims).toEqual(keys.map(key => `Synthetic claim ${key.slice(4)}`));
    expect(queries.filter(query => query.includes('FROM course_skill_knowledge_chunks'))).toHaveLength(12);
    expect(queries).toHaveLength(13);
    expect(Math.max(...bindingCounts)).toBeLessThanOrEqual(100);
    expect(result.candidates).toBe(0);
  } finally { await fixture.dispose(); }
}, 30_000);
