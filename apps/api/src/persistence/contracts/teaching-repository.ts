import type {TeachingTicket} from '../../shared/teaching';
import type {MaterialsService} from '../../features/lms/contracts';
export type TeachingConnection={id:string;provider:string;installationId:string;contextId:string;teacherSubject:string;resourceLinkId:string|null;ownerUserId:string;courseId:number;active:boolean;createdAt:string;courseTitle:string};
export type TeachingInstallation={id:string;clientId:string;deploymentId:string;materialsService:MaterialsService|null};
export interface TeachingRepository {
 consumeBootstrapNonce(id:string,expiresAt:Date):Promise<boolean>;
 findConnection(provider:'moodle'|'classroom',installationId:string,contextId:string):Promise<TeachingConnection|null>;
 findInstallation(id:string):Promise<TeachingInstallation|null>;
 connect(ticketId:string,ownerUserId:string,verified:TeachingTicket,selectedCourseId?:number):Promise<{returnUrl:string;courseId:number}>;
 courses(ownerUserId:string):Promise<Array<{id:number;name:string}>>;
 connections(ownerUserId:string):Promise<Array<{id:string;provider:string;contextId:string;courseId:number;name:string;active:boolean}>>;
 disconnect(id:string,ownerUserId:string):Promise<boolean>;
}
