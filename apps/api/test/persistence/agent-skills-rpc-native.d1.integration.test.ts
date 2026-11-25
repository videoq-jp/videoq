import { it, expect } from 'vitest';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';

it('creates, resumes and reads a large skill snapshot inside the native Worker runtime', async () => {
  const bundle = await build({ absWorkingDir: fileURLToPath(new URL('../../', import.meta.url)), stdin: { resolveDir: fileURLToPath(new URL('../../', import.meta.url)), contents: `
    import { createD1AgentSkillRepository } from './src/persistence/d1/agent-skill-repository';
    export default { async fetch(request, env) {
      const repository = createD1AgentSkillRepository(env.DB);
      const id = 'native-skill', ownerId = 'native-owner';
      if (new URL(request.url).pathname === '/create') {
        const state = { version: 1, target: {kind:'course',resourceId:51}, objective:'', automatic:true, language:'ja', resourceTitle:'Large course',fingerprint:'native',stage:'extracting',
          chunks:Array.from({length:282},(_,chunk)=>Array.from({length:333},(_,cue)=>({id:'v'+chunk+'-c'+cue,videoId:chunk,title:'講座から学ぶ具体的なエンジニアリングの意思決定',start:'00:01:00.000',end:'00:01:05.000',text:'講師が説明する手順と適用条件。'.repeat(6)}))),
          completedChunks:0,sourceVideos:177,facts:[],draft:null,issues:[] };
        await repository.create({id,ownerId,state});
        return Response.json({created:true});
      }
      const record = await repository.get(id,ownerId);
      if (!record) return new Response('missing',{status:404});
      if (new URL(request.url).pathname === '/save') {
        await repository.claim(id,ownerId,'lease',1,2000);
        record.state.completedChunks=1;
        if (!await repository.save(id,ownerId,'lease',record.state)) throw Error('save failed');
      }
      return Response.json({cues:record.state.chunks.reduce((n,c)=>n+c.length,0),completedChunks:record.state.completedChunks});
    }};
  ` }, bundle: true, write: false, format: 'esm', platform: 'browser', target: 'es2022' });
  const runtime = new Miniflare(convertV4MiniflareOptions({ modules: true, script: bundle.outputFiles[0].text, compatibilityDate: '2026-08-20', d1Databases: ['DB'] }));
  try {
    const database = await runtime.getD1Database('DB');
    await database.batch([
      database.prepare('CREATE TABLE users(id TEXT PRIMARY KEY)'),
      database.prepare('CREATE TABLE agent_skills(id TEXT PRIMARY KEY,owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,state TEXT NOT NULL,lease_token TEXT,lease_expires_at INTEGER,created_at TEXT NOT NULL)'),
      database.prepare('CREATE TABLE agent_skill_state_parts(skill_id TEXT NOT NULL REFERENCES agent_skills(id) ON DELETE CASCADE,revision TEXT NOT NULL,part INTEGER NOT NULL,content TEXT NOT NULL,PRIMARY KEY(skill_id,revision,part))'),
      database.prepare("INSERT INTO users VALUES('native-owner')"),
    ]);
    expect(await (await runtime.dispatchFetch('http://fixture/create')).json()).toEqual({created:true});
    expect(await (await runtime.dispatchFetch('http://fixture/read')).json()).toEqual({cues:93_906,completedChunks:0});
    expect(await (await runtime.dispatchFetch('http://fixture/save')).json()).toEqual({cues:93_906,completedChunks:1});
    expect(await (await runtime.dispatchFetch('http://fixture/read')).json()).toEqual({cues:93_906,completedChunks:1});
  } finally { await runtime.dispose(); }
}, 60_000);
