import {createLmsResourceReadRepository,createLmsResourceSyncRepository} from '../persistence/factory';
import {digest} from '../features/lti/store';
import {asLmsSyncError,type ResourceManifest} from '../features/lms/resource';
import {createLmsResourceService} from '../features/lms/resource-service';
import {lmsIdentity} from '../features/lms/contracts';
import {features} from '../lib/deployment';
import type {LmsGrant} from '../persistence/contracts/lms-resource-repository';
import type {Bindings} from '../types/bindings';
export type {LmsGrant} from '../persistence/contracts/lms-resource-repository';
export async function syncLmsResource(env:Bindings,grant:LmsGrant,externalId:string,manifest:ResourceManifest){
 try {return await createLmsResourceService({
  youtube:()=>features(env).youtube,validExternalId:value=>lmsIdentity.safeParse(value).success,
  digest,repository:()=>createLmsResourceSyncRepository(env),
 }).sync(grant,externalId,manifest);}
 catch(error){throw asLmsSyncError(error)??error;}
}
export async function getLmsResource(env:Bindings,grant:LmsGrant,externalId:string){return (await createLmsResourceReadRepository(env)).get(grant,externalId);}
