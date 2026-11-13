import {newSyncToken,provisionInstallationSchema,provisionServiceInstallationSchema,syncTokenHash,type ProvisionInstallation,type ProvisionServiceInstallation} from '../features/lms/installation';
import {createLmsInstallationRepository} from '../persistence/factory';
import type {Bindings} from '../types/bindings';
export async function provisionLmsInstallation(env:Bindings,input:ProvisionInstallation){
  const registration=provisionInstallationSchema.parse(input),token=newSyncToken(),hash=(await syncTokenHash(token))!;
  await (await createLmsInstallationRepository(env)).insert({...registration,syncTokenHash:hash});return {installationId:registration.id,token};
}
export async function provisionLmsServiceInstallation(env:Bindings,input:ProvisionServiceInstallation){
  const registration=provisionServiceInstallationSchema.parse(input);
  await (await createLmsInstallationRepository(env)).insert({...registration,syncTokenHash:null});return {installationId:registration.id,mode:'service' as const};
}
export async function authenticateLmsInstallation(env:Bindings,token:string){
  const hash=await syncTokenHash(token);return hash?(await createLmsInstallationRepository(env)).authenticate(hash):null;
}
export async function rotateLmsSyncToken(env:Bindings,ownerUserId:string,installationId:string){
  const token=newSyncToken(),hash=(await syncTokenHash(token))!;
  const id=await (await createLmsInstallationRepository(env)).rotate(ownerUserId,installationId,hash);return id?{installationId:id,token}:null;
}
export async function disconnectLmsInstallation(env:Bindings,ownerUserId:string,installationId:string){return (await createLmsInstallationRepository(env)).disconnect(ownerUserId,installationId);}
export async function listActiveLmsInstallations(env:Bindings,ownerUserId:string){return (await createLmsInstallationRepository(env)).listActive(ownerUserId);}
