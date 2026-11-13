import {createCredentialRepository} from '../../persistence/factory';
import {ApiError} from '../../shared/errors';
import {ltiSessionProof} from '../../shared/lti-session-proof';
import {sessionRecord} from './protocol';
import type {Bindings} from '../../types/bindings';

export async function digest(value: string): Promise<string> {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(bytes), b => b.toString(16).padStart(2, "0")).join("");
}
export function randomSecret(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(32)), b => b.toString(16).padStart(2, "0")).join("");
}


export async function putCredential(env:Bindings,id:string,kind:string,payload:Record<string,unknown>,seconds:number){
  await (await createCredentialRepository(env)).put(id,kind,payload,Date.now()+seconds*1000);
}
export async function readCredential(env:Bindings,id:string,kind:string){return (await createCredentialRepository(env)).read(id,kind);}
export async function recordScopeVideos(env:Bindings,id:string,videoIds:number[]):Promise<number[]|null>{return (await createCredentialRepository(env)).recordScopeVideos(id,videoIds);}
export async function consumeLogin(env:Bindings,id:string):Promise<boolean>{return consumeCredential(env,id,'login');}
export async function consumeCredential(env:Bindings,id:string,kind:string):Promise<boolean>{return (await createCredentialRepository(env)).consume(id,kind);}
export async function pruneLtiCredentials(env:Bindings){await (await createCredentialRepository(env)).prune();}
export async function putLtiFeedback(env:Bindings,id:string,sessionHash:string,courseId:number,logId:number){
  const session=sessionRecord.safeParse(await readCredential(env,sessionHash,'session'));
  if(!session.success)throw new ApiError(403,'FORBIDDEN','The Moodle session is unavailable.');
  await (await createCredentialRepository(env)).putFeedback(id,ltiSessionProof(session.data,sessionHash),courseId,logId,Date.now()+3600_000);
}

/** Replace a live credential without extending retention or reviving deletion. */
export async function replaceCredentialPayload(env:Bindings,id:string,kind:string,payload:Record<string,unknown>):Promise<boolean>{
  return (await createCredentialRepository(env)).replacePayload(id,kind,payload);
}
