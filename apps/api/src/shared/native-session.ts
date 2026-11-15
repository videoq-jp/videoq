import {ApiError} from './errors';
import {sessionRecord} from '../features/lti/protocol';
import type {NativeSessionInput} from '../persistence/contracts/native-session-repository';
export const nativeSessionDenied=()=>new ApiError(403,'FORBIDDEN','The LMS learning session is unavailable.');
export function validateNativeSessionInput(input:NativeSessionInput):void{
 const grant=sessionRecord.safeParse(input.grant);
 if(!grant.success||grant.data.transport!=='native'||!input.ownerUserId||
  new Set([input.sessionHash,input.markerHash,input.nonceHash]).size!==3||
  [input.sessionHash,input.markerHash,input.nonceHash].some(id=>!id)||
  !Number.isFinite(new Date(input.expiresAt.getTime()+120_000).getTime())||!Number.isFinite(input.nonceExpiresAt.getTime()))throw nativeSessionDenied();
}
export function matchesNativeSession(payload:unknown,expiresAt:Date,input:NativeSessionInput):boolean{
 const stored=sessionRecord.safeParse(payload);
 if(!stored.success||stored.data.transport!=='native'||expiresAt.getTime()<=Date.now()||expiresAt.getTime()!==input.expiresAt.getTime())return false;
 for(const field of ['registrationId','registrationHash','subjectHash','deploymentId','contextId','resourceLinkId','courseId','videoId','resourceGeneration','serviceSubject'] as const){
  if(stored.data[field]!==input.grant[field])return false;
 }
 return true;
}
