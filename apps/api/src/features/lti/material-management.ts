import {createMaterialManagementRepository} from '../../persistence/factory';
import {materialManagementInput,checkMaterialManagement} from '../../shared/material-management';
import type {z} from 'zod';
import type {Bindings} from '../../types/bindings';
import type {ManagedMaterialScope} from '../../persistence/contracts/material-management-repository';
export {materialManagementInput} from '../../shared/material-management';
export type {ManagedMaterialScope} from '../../persistence/contracts/material-management-repository';
export async function manageLtiMaterial(env:Bindings,scope:ManagedMaterialScope,input:z.infer<typeof materialManagementInput>){
 checkMaterialManagement(scope,input);
 return (await createMaterialManagementRepository(env)).execute(scope,input);
}
