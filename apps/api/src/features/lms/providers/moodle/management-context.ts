import type {moodleManagementRequest} from '@videoq/trpc/moodle-management';
import type {z} from 'zod';
import {createLmsInstallationRepository} from '../../../../persistence/factory';
import {features} from '../../../../lib/deployment';
import type {Bindings} from '../../../../types/bindings';
/** Independent account authentication is mandatory; LMS roles are not inputs. */
export async function managementContext(env:Bindings,userId:string,input:z.infer<typeof moodleManagementRequest>){
 const access=await (await createLmsInstallationRepository(env)).managementAccess(userId,input);
 if(!access)return null;
 const owned=access.connectionActive!==null;
 return {connection:{owned,active:access.connectionActive},permissions:{account:owned,billing:owned&&features(env).billing,systemAdmin:access.systemAdmin}};
}
