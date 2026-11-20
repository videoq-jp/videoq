import type { MaterialCommand, MaterialView, ManagedMaterialScope } from '../../application/material-management';
export type { ManagedMaterialScope, ManagedVideo, MaterialJob } from '../../application/material-management';
export interface MaterialManagementRepository{execute(scope:ManagedMaterialScope,input:MaterialCommand):Promise<{material:MaterialView;externalTaskId:number|null;reused:boolean}>;}
