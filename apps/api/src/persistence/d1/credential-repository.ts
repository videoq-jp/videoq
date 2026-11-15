import {and,eq,sql} from 'drizzle-orm';
import {createD1Connection} from '../../db/d1/connection';
import {ltiCredentials} from '../../db/schema/sqlite';
import {ApiError} from '../../shared/errors';
import {ltiSessionProof} from '../../shared/lti-session-proof';
import type {CredentialRepository} from '../contracts/credential-repository';
export function createD1CredentialRepository(database:D1Database):CredentialRepository {
  const db=createD1Connection(database);
  const live=(id:string,kind:string)=>and(eq(ltiCredentials.id,id),eq(ltiCredentials.kind,kind),sql`julianday(${ltiCredentials.expiresAt})>julianday('now')`);
  return {
    async put(id,kind,payload,expiresAt){await db.insert(ltiCredentials).values({id,kind,payload,expiresAt:new Date(expiresAt)});},
    async read(id,kind){return (await db.select({payload:ltiCredentials.payload}).from(ltiCredentials).where(live(id,kind)).limit(1))[0]?.payload??null;},
    async replacePayload(id,kind,payload){return (await db.update(ltiCredentials).set({payload}).where(live(id,kind)).returning({id:ltiCredentials.id})).length===1;},
    async recordScopeVideos(id,videoIds){
      // json_each exposes booleans as 0/1; preserve their JSON type so malformed
      // stored scopes cannot become authorized numeric video IDs.
      const row=await database.prepare(`UPDATE lti_credentials SET payload=json_set(payload,'$.scopeVideoIds',json((
        SELECT json_group_array(CASE WHEN type IN('array','object') THEN json(value)
          WHEN type='true' THEN json('true') WHEN type='false' THEN json('false') ELSE value END) FROM (
          SELECT value,type FROM json_each(CASE WHEN json_type(payload,'$.scopeVideoIds') IS NULL THEN '[]'
            WHEN json_type(payload,'$.scopeVideoIds')='array' THEN payload -> '$.scopeVideoIds'
            ELSE json_array(json(payload -> '$.scopeVideoIds')) END)
          UNION SELECT value,type FROM json_each(?)
        )))) WHERE id=? AND kind='session' AND julianday(expires_at)>julianday('now') RETURNING payload`)
        .bind(JSON.stringify(videoIds),id).first<{payload:string}>();
      const ids=row?(JSON.parse(row.payload) as Record<string,unknown>).scopeVideoIds:undefined;
      return Array.isArray(ids) && ids.every(Number.isSafeInteger)?ids as number[]:null;
    },
    async consume(id,kind){return (await db.delete(ltiCredentials).where(live(id,kind)).returning({id:ltiCredentials.id})).length===1;},
    async prune(){await db.delete(ltiCredentials).where(sql`julianday(${ltiCredentials.expiresAt})<=julianday('now')`);},
    async putFeedback(id,proof,courseId,logId,expiresAt){
      ltiSessionProof(proof,proof.sessionHash);
      const row=await database.prepare(`INSERT INTO lti_credentials(id,kind,payload,expires_at)
        SELECT ?,'lti-feedback',?,? WHERE EXISTS(SELECT 1 FROM video_courses course JOIN users owner ON owner.id=course.user_id
          JOIN lti_credentials session ON session.id=? WHERE course.id=? AND session.kind='session' AND julianday(session.expires_at)>julianday('now')
          AND json_extract(session.payload,'$.registrationId')=? AND json_extract(session.payload,'$.subjectHash')=?) RETURNING id`)
        .bind(id,JSON.stringify({sessionHash:proof.sessionHash,courseId,logId}),new Date(expiresAt).toISOString(),proof.sessionHash,courseId,proof.registrationId,proof.subjectHash).first();
      if(!row)throw new ApiError(403,'FORBIDDEN','The Moodle session is unavailable.');
    },
  };
}
