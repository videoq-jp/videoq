import {newSyncToken,provisionInstallationSchema,provisionServiceInstallationSchema,syncTokenHash,type ProvisionInstallation,type ProvisionServiceInstallation} from '../features/lms/installation';
import {createLmsInstallationRepository} from '../persistence/factory';
import type {Bindings} from '../types/bindings';
import {createLmsInstallationService} from '../features/lms/installation-service';
function service(env:Bindings){return createLmsInstallationService({
 newToken:newSyncToken,hash:syncTokenHash,repository:()=>createLmsInstallationRepository(env),
});}
export async function provisionLmsInstallation(env:Bindings,input:ProvisionInstallation){
  return service(env).provision(provisionInstallationSchema.parse(input));
}
export async function provisionLmsServiceInstallation(env:Bindings,input:ProvisionServiceInstallation){
  return service(env).provisionService(provisionServiceInstallationSchema.parse(input));
}
export async function authenticateLmsInstallation(env:Bindings,token:string){
  return service(env).authenticate(token);
}
export async function rotateLmsSyncToken(env:Bindings,ownerUserId:string,installationId:string){
  return service(env).rotate(ownerUserId,installationId);
}
export async function disconnectLmsInstallation(env:Bindings,ownerUserId:string,installationId:string){return (await createLmsInstallationRepository(env)).disconnect(ownerUserId,installationId);}
export async function listActiveLmsInstallations(env:Bindings,ownerUserId:string){return (await createLmsInstallationRepository(env)).listActive(ownerUserId);}
