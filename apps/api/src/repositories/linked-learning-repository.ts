import {createLinkedLearningRepository} from '../persistence/factory';
import type {Bindings} from '../types/bindings';
export async function linkedLearningCourse(env:Bindings,installationId:string,contextId:string){
 return (await createLinkedLearningRepository(env)).findCourse(installationId,contextId);
}
