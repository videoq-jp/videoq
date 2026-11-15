export type LmsGrant={id:string;ownerUserId?:string;materialsLease?:{id:string;token:string}};
export type OwnedLmsGrant=LmsGrant & {ownerUserId:string};
export type LmsResource={id:string;installationId:string;externalId:string;kind:string;contextId:string;resourceLinkId:string;generation:number;manifestHash:string;enabled:boolean;
 contentHash:string|null;contentType:string|null;fileSize:number|null;youtubeVideoId:string|null;courseId:number|null;videoId:number|null;syncError:string|null;updatedAt:string};
/** Source metadata needed by authenticated connector/worker operations, not presigned URLs. */
export type LmsResourceVideo={id:number;managedByLms:boolean;transcriptionLanguage:string|null;file:string;multipartUpload:{uploadId:string;partSize:number;contentType:string}|null;
 uploadHeartbeatAt:string|null;uploadUsagePeriodStart:string|null;title:string;description:string;uploadedAt:string;transcript:string;status:string;errorMessage:string;processingSeconds:number;
 userId:string;sourceType:string;sourceUrl:string;youtubeVideoId:string};
export type LmsResourceData={resource:LmsResource;video:LmsResourceVideo|null;ownerUserId:string};
export interface LmsResourceReadRepository {get(grant:LmsGrant,externalId:string):Promise<LmsResourceData|null>;}

export interface LmsResourceSyncRepository {sync(grant:LmsGrant,externalId:string,manifest:import('../../features/lms/resource').ResourceManifest,manifestHash:string):Promise<LmsResource>;}
