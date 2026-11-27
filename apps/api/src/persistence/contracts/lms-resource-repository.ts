import type { LmsResource, ResourceManifest } from '../../domain/lms/lms-resource';
import type { LmsGrant } from '../../domain/lms/lms-upload';
export type { LmsGrant, OwnedLmsGrant } from '../../domain/lms/lms-upload';
export type { LmsResource } from '../../domain/lms/lms-resource';
/** Source metadata needed by authenticated connector/worker operations, not presigned URLs. */
export type LmsResourceVideo={id:number;managedByLms:boolean;transcriptionLanguage:string|null;file:string;multipartUpload:{uploadId:string;partSize:number;contentType:string}|null;
 uploadHeartbeatAt:string|null;uploadUsagePeriodStart:string|null;title:string;description:string;uploadedAt:string;transcript:string;status:string;errorMessage:string;processingSeconds:number;
 userId:string;sourceType:string;sourceUrl:string;youtubeVideoId:string};
export type LmsResourceData={resource:LmsResource;video:LmsResourceVideo|null;ownerUserId:string};
export interface LmsResourceReadRepository {get(grant:LmsGrant,externalId:string):Promise<LmsResourceData|null>;}

export interface LmsResourceSyncRepository {sync(grant:LmsGrant,externalId:string,manifest:ResourceManifest,manifestHash:string):Promise<LmsResource>;}
