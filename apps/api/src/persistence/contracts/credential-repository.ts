import type {LtiSessionProof} from '../../shared/lti-session-proof';
/** Expiring protocol credentials, including one-use login/OAuth state. */
export interface CredentialRepository {
  put(id:string,kind:string,payload:Record<string,unknown>,expiresAt:number):Promise<void>;
  read(id:string,kind:string):Promise<Record<string,unknown>|null>;
  replacePayload(id:string,kind:string,payload:Record<string,unknown>):Promise<boolean>;
  recordScopeVideos(id:string,videoIds:number[]):Promise<number[]|null>;
  consume(id:string,kind:string):Promise<boolean>;
  prune():Promise<void>;
  putFeedback(id:string,proof:LtiSessionProof,courseId:number,logId:number,expiresAt:number):Promise<void>;
}
