import {createLmsResourceReadRepository,createLmsResourceSyncRepository} from '../persistence/factory';
import {digest} from '../features/lti/store';
import {LmsSyncError,type ResourceManifest} from '../features/lms/resource';
import {lmsIdentity} from '../features/lms/contracts';
import {features} from '../lib/deployment';
import type {LmsGrant} from '../persistence/contracts/lms-resource-repository';
import type {Bindings} from '../types/bindings';
export type {LmsGrant} from '../persistence/contracts/lms-resource-repository';
export async function syncLmsResource(env:Bindings,grant:LmsGrant,externalId:string,manifest:ResourceManifest){
 if(manifest.kind==='youtube' && manifest.enabled && !features(env).youtube)throw new LmsSyncError(403,'YOUTUBE_DISABLED');
 if(!lmsIdentity.safeParse(externalId).success)throw new LmsSyncError(400,'INVALID_MANIFEST');
 const manifestHash=await digest(JSON.stringify(manifest));
 return (await createLmsResourceSyncRepository(env)).sync(grant,externalId,manifest,manifestHash);
}
export async function getLmsResource(env:Bindings,grant:LmsGrant,externalId:string){return (await createLmsResourceReadRepository(env)).get(grant,externalId);}
