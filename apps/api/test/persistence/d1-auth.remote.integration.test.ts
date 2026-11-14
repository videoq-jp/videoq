import {createTeachingRepository,createLinkedLearningRepository,createChatRepository,createLearningMediaRepository} from '../../src/persistence/factory';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {getPlatformProxy,type PlatformProxy} from 'wrangler';
import {afterAll,beforeAll,describe,it,expect} from 'vitest';
import {validateSyntheticStagingTarget} from '../../scripts/migrations/d1/synthetic-staging-target';
import type {StagingBindings} from '../../scripts/migrations/d1/staging-migration';
import {createD1Auth} from '../../src/persistence/d1/auth';
import {createD1OAuthGrantRepository} from '../../src/persistence/d1/oauth-grant-repository';
import type {Bindings} from '../../src/types/bindings';
/** Opt-in only, after the synthetic PostgreSQL rehearsal archive was imported. */
describe.skipIf(process.env.PERSISTENCE_REMOTE_REHEARSAL_TEST!=='1')('synthetic PostgreSQL credentials on remote D1',()=>{
 let proxy:PlatformProxy<StagingBindings>;
 beforeAll(async()=>{const configPath=fileURLToPath(new URL('../../wrangler.d1-staging.v2.jsonc',import.meta.url));validateSyntheticStagingTarget(await readFile(configPath,'utf8'));proxy=await getPlatformProxy<StagingBindings>({configPath,envFiles:[],persist:false,remoteBindings:true});},60000);
 afterAll(async()=>{await proxy?.dispose();});
 it('signs in with the imported credential and reads the issued session from D1',async()=>{
  const db=proxy.env.DB,owner=await db.prepare("SELECT id,email FROM users WHERE id='migration-rehearsal-owner'").first<{id:string;email:string}>();expect(owner).toEqual({id:'migration-rehearsal-owner',email:'rehearsal-owner@example.invalid'});
  const settings={ENVIRONMENT:'test',DEPLOYMENT_EDITION:'cloud',DB:db,BETTER_AUTH_URL:'https://rehearsal.example.test',FRONTEND_URL:'https://rehearsal.example.test',BETTER_AUTH_SECRET:'synthetic-rehearsal-secret-01234567890123456789'};
  const auth=createD1Auth(settings as Bindings,db,'browser');let sessionId:string|undefined;const before=new Set((await db.prepare("SELECT id FROM session WHERE user_id='migration-rehearsal-owner'").all<{id:string}>()).results.map(row=>row.id));
  try{
   const signedIn=await auth.api.signInEmail({body:{email:owner!.email,password:'Synthetic-rehearsal-password-2026'},asResponse:true});expect(signedIn.status).toBe(200);
   const cookie=signedIn.headers.getSetCookie().map(value=>value.split(';')[0]).join('; '),session=await auth.api.getSession({headers:new Headers({cookie}),query:{disableCookieCache:true}});sessionId=session?.session.id;
   expect(session?.user.id).toBe(owner!.id);expect(sessionId).toBeTruthy();
   expect(await db.prepare("SELECT count(*) AS count FROM session WHERE id='rehearsal-session' AND user_id='migration-rehearsal-owner'").first('count')).toBe(1);
  }finally{const after=(await db.prepare("SELECT id FROM session WHERE user_id='migration-rehearsal-owner'").all<{id:string}>()).results;for(const row of after)if(!before.has(row.id))await db.prepare('DELETE FROM session WHERE id=?').bind(row.id).run();}
 },120000);
 it('hydrates migrated teacher ownership and verified author snapshots without granting the installer course ownership',async()=>{
  const env={DB:proxy.env.DB,DEPLOYMENT_EDITION:'cloud'} as Bindings;
  const teaching=await createTeachingRepository(env),linked=await createLinkedLearningRepository(env),chat=await createChatRepository(env),media=await createLearningMediaRepository(env);
  expect(await teaching.findConnection('moodle','rehearsal-school','rehearsal-context')).toMatchObject({ownerUserId:'migration-rehearsal-owner',courseId:1,resourceLinkId:'rehearsal-entry',teacherSubject:'synthetic-teacher'});
  expect(await linked.findCourse('rehearsal-school','rehearsal-context')).toMatchObject({ownerUserId:'migration-rehearsal-owner',courseId:1,videos:[{videoId:1,title:'Synthetic rehearsal'}]});
  const history=await chat.history(1,'migration-rehearsal-owner',10,0);expect(history).toMatchObject({count:1,results:[{question:'Synthetic attributed question',asked_by:{user_id:'synthetic-learner',username:'Synthetic learner',email:'rehearsal-learner@example.invalid'}}]});
  expect(await chat.history(1,'migration-rehearsal-learner',10,0)).toEqual({notFound:true});
  expect(await media.summaries('migration-rehearsal-learner',[1])).toEqual([]);
  expect(await media.playback('migration-rehearsal-learner',1)).toBeNull();
 },60000);

 it('atomically revokes synthetic OAuth grants on remote D1 and rolls back a late failure',async()=>{
  const db=proxy.env.DB,prefix='grant-'+crypto.randomUUID(),owner=prefix+'-owner',peer=prefix+'-peer',client=prefix+'-client',other=prefix+'-other';
  const trigger='grant_failure_'+crypto.randomUUID().replaceAll('-','');
  const grants=[[prefix,owner,client],[prefix+'-resource',owner,client],[prefix+'-other',owner,other],[prefix+'-peer',peer,client]];
  const snapshot=async()=>{
   const tables=['oauth_consent','oauth_refresh_token','oauth_access_token'];
   return Promise.all(tables.map(async table=>(await db.prepare(`SELECT id FROM ${table} WHERE user_id IN (?,?) ORDER BY id`).bind(owner,peer).all<{id:string}>()).results.map(row=>row.id)));
  };
  try{
   await db.batch([
    ...[owner,peer].map(id=>db.prepare('INSERT INTO users(id,username,email,is_over_quota,used_ai_answers,used_processing_seconds,used_storage_bytes) VALUES(?,?,?,0,0,0,0)').bind(id,id,id+'@example.invalid')),
    ...[client,other].map(id=>db.prepare("INSERT INTO oauth_client(id,client_id,redirect_uris) VALUES(?,?,'[]')").bind(id,id)),
    ...grants.flatMap(([id,user,app])=>[
     db.prepare("INSERT INTO oauth_consent(id,user_id,client_id,scopes) VALUES(?,?,?,'[]')").bind(id,user,app),
     db.prepare("INSERT INTO oauth_refresh_token(id,user_id,client_id,token,scopes,rotation_replay_response) VALUES(?,?,?,?,'[]','synthetic rotation replay')").bind('refresh-'+id,user,app,'synthetic-refresh-'+id),
     db.prepare("INSERT INTO oauth_access_token(id,user_id,client_id,token,refresh_id,scopes) VALUES(?,?,?,?,?,'[]')").bind('access-'+id,user,app,'synthetic-access-'+id,'refresh-'+id),
    ]),
   ]);
   const before=await snapshot(),repository=createD1OAuthGrantRepository(db);
   // UUID-derived identifiers only; this fault trigger cannot affect other users.
   await db.prepare(`CREATE TRIGGER ${trigger} BEFORE DELETE ON oauth_consent WHEN OLD.user_id='${owner}' AND OLD.client_id='${client}' BEGIN SELECT RAISE(ABORT,'synthetic revocation failure'); END`).run();
   await expect(repository.revoke(owner,prefix)).rejects.toThrow('OAuth grant revocation persistence failed.');
   expect(await snapshot()).toEqual(before);
   await db.prepare(`DROP TRIGGER ${trigger}`).run();
   expect(await repository.revoke(peer,prefix)).toBe(false);expect(await snapshot()).toEqual(before);
   expect(await repository.revoke(owner,prefix)).toBe(true);
   expect(await snapshot()).toEqual(['','refresh-','access-'].map(kind=>[kind+prefix+'-other',kind+prefix+'-peer'].sort()));
   expect(await repository.revoke(owner,prefix)).toBe(false);
  }finally{
   await db.prepare(`DROP TRIGGER IF EXISTS ${trigger}`).run();
   await db.batch([
    ...['oauth_access_token','oauth_refresh_token','oauth_consent'].map(table=>db.prepare(`DELETE FROM ${table} WHERE user_id IN (?,?)`).bind(owner,peer)),
    db.prepare('DELETE FROM oauth_client WHERE client_id IN (?,?)').bind(client,other),
    db.prepare('DELETE FROM users WHERE id IN (?,?)').bind(owner,peer),
   ]);
  }
  expect(await snapshot()).toEqual([[],[],[]]);
  expect(await db.prepare('SELECT count(*) AS n FROM users WHERE id IN (?,?)').bind(owner,peer).first('n')).toBe(0);
  expect(await db.prepare('SELECT count(*) AS n FROM oauth_client WHERE client_id IN (?,?)').bind(client,other).first('n')).toBe(0);
  expect(await db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type='trigger' AND name=?").bind(trigger).first('n')).toBe(0);
 },180000);
});
