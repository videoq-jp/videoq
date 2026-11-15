import type {OutboxedVideoJob} from './video-upload-repository';
import type {MaterialsService} from '../../features/lms/contracts';
export type MaterialsConnection={id:string;ownerUserId:string;clientId:string;deploymentId:string;materialsService:MaterialsService;materialsCursor:number};
export type MaterialsLease={id:string;token:string;installationId:string};
export type MaterialsClaim={status:'claimed';lease:MaterialsLease;connection:MaterialsConnection}|{status:'busy'}|{status:'unavailable'};
export type MaterialsExport={attempt:string;jobId?:string};
export class MaterialsLeaseLostError extends Error {constructor(){super('LTI materials lease is no longer current');}}
export interface MaterialsSyncRepository {
 claimContext(installationId:string,leaseId:string,token:string):Promise<MaterialsClaim>;
 owns(lease:MaterialsLease):Promise<boolean>;
 release(lease:MaterialsLease):Promise<void>;
 prepareExport(lease:MaterialsLease,key:string,contextId:string,attempt:string):Promise<MaterialsExport>;
 saveExportJob(lease:MaterialsLease,key:string,attempt:string,jobId:string):Promise<boolean>;
 deleteExport(lease:MaterialsLease,key:string,attempt:string):Promise<boolean>;
 confirmUpload(lease:MaterialsLease, upload:{externalId:string;generation:number;videoId:number;fileKey:string}):Promise<false|OutboxedVideoJob>;
 claimNext(token:string):Promise<{lease:MaterialsLease;connection:MaterialsConnection}|null>;
 finishPoll(lease:MaterialsLease,cursor:number,delaySeconds:number):Promise<boolean>;
}
