import type {LtiSessionProof} from '../../shared/lti-session-proof';
import type {z} from 'zod';
import type {materialManagementInput,materialView} from '../../shared/material-management';
export type ManagedMaterialScope = {
  installationId: string; ownerUserId: string; courseId: number; contextId: string;
  resourceLinkId: string; videoId: number; generation: number; actorKey: string;
  sessionProof?: LtiSessionProof;
};
export type ManagedVideo={title:string;description:string|null;transcript:string|null;status:string;file:string};
export type MaterialJob={id:string|number;message:unknown;dead:boolean;status:string|null};
export interface MaterialManagementRepository{execute(scope:ManagedMaterialScope,input:z.infer<typeof materialManagementInput>):Promise<{material:Awaited<ReturnType<typeof materialView>>;externalTaskId:number|null;reused:boolean}>;}
