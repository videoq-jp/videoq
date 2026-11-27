import { managementContextView } from "../../../../domain/lms/lms-management";
import type {moodleManagementRequest} from '@videoq/trpc/moodle-management';
import type {z} from 'zod';
import {createLmsInstallationRepository} from '../../../../persistence/factory';
import {features} from '../../../../lib/deployment';
import type {Bindings} from '../../../../types/bindings';
/** Independent account authentication is mandatory; LMS roles are not inputs. */
export async function managementContext(env:Bindings,userId:string,input:z.infer<typeof moodleManagementRequest>){
 const access=await (await createLmsInstallationRepository(env)).managementAccess(userId,input);
 return managementContextView(access,()=>features(env).billing);
}
