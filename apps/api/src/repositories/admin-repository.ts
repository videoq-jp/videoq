import type { Bindings } from "../types/bindings";
import {createAdminUserRepository} from "../persistence/factory";
import type {AdminQuotaPatch,AdminUsagePatch,AdminFlagsPatch} from "../persistence/contracts/admin-user-repository";
export type {AdminUser} from "../persistence/contracts/admin-user-repository";
export async function isAdmin(env:Bindings,id:string){return (await createAdminUserRepository(env)).isAdmin(id);}
export async function listAdminUsers(env:Bindings,q:string,limit:number,offset:number){return (await createAdminUserRepository(env)).list(q,limit,offset);}
export async function getAdminUser(env:Bindings,id:string){return (await createAdminUserRepository(env)).find(id);}
export async function patchAdminUserQuota(env:Bindings,id:string,patch:AdminQuotaPatch){return (await createAdminUserRepository(env)).patchQuota(id,patch);}
export async function patchAdminUserUsage(env:Bindings,id:string,patch:AdminUsagePatch){return (await createAdminUserRepository(env)).patchUsage(id,patch);}
export async function patchAdminUserFlags(env:Bindings,actorId:string,targetId:string,patch:AdminFlagsPatch,headers:Headers){
 return (await createAdminUserRepository(env)).patchFlags(actorId,targetId,patch,headers);
}
export async function lockUserForHardDelete(env:Bindings,id:string){
 return (await createAdminUserRepository(env)).lockForHardDelete(id);
}
