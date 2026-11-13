import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {getPlatformProxy,type PlatformProxy} from 'wrangler';
import {afterAll,beforeAll,describe,it,expect} from 'vitest';
import {validateStagingTarget} from '../../scripts/migrations/d1/staging-target';
import type {StagingBindings} from '../../scripts/migrations/d1/staging-migration';
import {createD1Auth} from '../../src/persistence/d1/auth';
import type {Bindings} from '../../src/types/bindings';
/** Opt-in only, after the synthetic PostgreSQL rehearsal archive was imported. */
describe.skipIf(process.env.PERSISTENCE_REMOTE_REHEARSAL_TEST!=='1')('synthetic PostgreSQL credentials on remote D1',()=>{
 let proxy:PlatformProxy<StagingBindings>;
 beforeAll(async()=>{const configPath=fileURLToPath(new URL('../../wrangler.d1-staging.jsonc',import.meta.url));validateStagingTarget(await readFile(configPath,'utf8'));proxy=await getPlatformProxy<StagingBindings>({configPath,envFiles:[],persist:false,remoteBindings:true});},60000);
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
});
