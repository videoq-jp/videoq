import {and,eq,gt,lte,sql} from 'drizzle-orm';
import {withDb} from '../../db/pool';
import {ltiCredentials,videoCourses} from '../../db/schema';
import {ApiError} from '../../shared/errors';
import {lockLtiDataSessionWithDb} from './lti-session-lock';
import type {Bindings} from '../../types/bindings';
import type {CredentialRepository} from '../contracts/credential-repository';
export function createPostgresCredentialRepository(env:Bindings):CredentialRepository {
  return {
    async put(id,kind,payload,expiresAt){await withDb(env,db=>db.insert(ltiCredentials).values({id,kind,payload,expiresAt:new Date(expiresAt)}));},
    read(id,kind){return withDb(env,async db=>(await db.select().from(ltiCredentials).where(and(eq(ltiCredentials.id,id),eq(ltiCredentials.kind,kind),gt(ltiCredentials.expiresAt,new Date()))).limit(1))[0]?.payload??null);},
    replacePayload(id,kind,payload){return withDb(env,async db=>(await db.update(ltiCredentials).set({payload}).where(and(eq(ltiCredentials.id,id),eq(ltiCredentials.kind,kind),gt(ltiCredentials.expiresAt,new Date()))).returning({id:ltiCredentials.id})).length===1);},
    recordScopeVideos(id,videoIds){return withDb(env,async db=>{
      const [row]=await db.update(ltiCredentials).set({payload:sql`jsonb_set(${ltiCredentials.payload}, '{scopeVideoIds}', (
        SELECT coalesce(jsonb_agg(DISTINCT item), '[]'::jsonb)
        FROM jsonb_array_elements(coalesce(${ltiCredentials.payload}->'scopeVideoIds', '[]'::jsonb) || ${JSON.stringify(videoIds)}::jsonb) AS item
      ))`}).where(and(eq(ltiCredentials.id,id),eq(ltiCredentials.kind,'session'),gt(ltiCredentials.expiresAt,new Date()))).returning({payload:ltiCredentials.payload});
      const ids=row?.payload.scopeVideoIds;return Array.isArray(ids) && ids.every(Number.isSafeInteger)?ids as number[]:null;
    });},
    async consume(id,kind){return withDb(env,async db=>(await db.delete(ltiCredentials).where(and(eq(ltiCredentials.id,id),eq(ltiCredentials.kind,kind),gt(ltiCredentials.expiresAt,new Date()))).returning({id:ltiCredentials.id})).length===1);},
    async prune(){await withDb(env,db=>db.delete(ltiCredentials).where(lte(ltiCredentials.expiresAt,new Date())));},
    async putFeedback(id,proof,courseId,logId,expiresAt){await withDb(env,db=>db.transaction(async tx=>{
      const [course]=await tx.select({owner:videoCourses.userId}).from(videoCourses).where(eq(videoCourses.id,courseId));
      if(!course)throw new ApiError(403,'FORBIDDEN','The Moodle session is unavailable.');
      await lockLtiDataSessionWithDb(tx,course.owner,proof);
      await tx.insert(ltiCredentials).values({id,kind:'lti-feedback',payload:{sessionHash:proof.sessionHash,courseId,logId},expiresAt:new Date(expiresAt)});
    }));},
  };
}
