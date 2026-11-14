import type {LearningAuthorization} from '../../features/lti/session-authorization';
export type NativeSessionInput={
 ownerUserId:string;grant:LearningAuthorization['grant'];sessionHash:string;markerHash:string;
 nonceHash:string;nonceExpiresAt:Date;expiresAt:Date;
};
/** Consume one signed request without replacing an existing session or its scope union. */
export interface NativeSessionRepository {ensure(input:NativeSessionInput):Promise<void>;}
