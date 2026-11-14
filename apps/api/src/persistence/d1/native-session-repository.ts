import type {NativeSessionRepository} from '../contracts/native-session-repository';
import {nativeSessionDenied,matchesNativeSession,validateNativeSessionInput} from '../../shared/native-session';
type Credential={id:string;kind:string;payload:string;expires_at:string};
export function createD1NativeSessionRepository(database:D1Database):NativeSessionRepository{return {async ensure(input){
 validateNativeSessionInput(input);
 // Pre-validate the typed session, then compare its exact snapshot in the
 // atomic batch. A concurrent scope union retries rather than overwriting it.
 for(let retry=0;retry<5;retry++){
  const rows=await database.prepare('SELECT id,kind,payload,expires_at FROM lti_credentials WHERE id IN (?,?,?)')
   .bind(input.sessionHash,input.markerHash,input.nonceHash).all<Credential>();
  const session=rows.results.find(r=>r.id===input.sessionHash),marker=rows.results.find(r=>r.id===input.markerHash);
  if(rows.results.some(r=>r.id===input.nonceHash))throw nativeSessionDenied();
  let payload:unknown;try{payload=session?JSON.parse(session.payload):undefined;}catch{throw nativeSessionDenied();}
  if(marker){
   if(marker.kind!=='moodle-native-started'||!session||session.kind!=='session'||
    !matchesNativeSession(payload,new Date(session.expires_at),input))throw nativeSessionDenied();
  }else if(session)throw nativeSessionDenied();
  const snapshot=marker?`EXISTS(SELECT 1 FROM lti_credentials WHERE id=? AND kind='moodle-native-started')
   AND EXISTS(SELECT 1 FROM lti_credentials WHERE id=? AND kind='session' AND payload=? AND expires_at=? AND julianday(expires_at)>julianday('now'))`
   :`NOT EXISTS(SELECT 1 FROM lti_credentials WHERE id IN (?,?))`;
  const args=marker?[input.markerHash,input.sessionHash,session!.payload,session!.expires_at]:[input.markerHash,input.sessionHash];
  const result=await database.batch([
   database.prepare(`INSERT INTO lti_credentials(id,kind,payload,expires_at)
    SELECT ?,'moodle-native-request','{}',? WHERE EXISTS(SELECT 1 FROM users WHERE id=?) AND julianday(?)>julianday('now') AND ${snapshot}
    ON CONFLICT DO NOTHING`).bind(input.nonceHash,input.nonceExpiresAt.toISOString(),input.ownerUserId,input.expiresAt.toISOString(),...args),
   database.prepare(`INSERT INTO lti_credentials(id,kind,payload,expires_at)
    SELECT ?,'moodle-native-started','{}',? WHERE changes()=1 ON CONFLICT DO NOTHING`)
    .bind(input.markerHash,new Date(input.expiresAt.getTime()+120_000).toISOString()),
   database.prepare(`INSERT INTO lti_credentials(id,kind,payload,expires_at)
    SELECT ?,'session',?,? WHERE changes()=1 ON CONFLICT DO NOTHING`)
    .bind(input.sessionHash,JSON.stringify(input.grant),input.expiresAt.toISOString()),
  ]);
  if(result[0].meta.changes===1)return;
 }
 throw nativeSessionDenied();
}};}
