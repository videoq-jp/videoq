import type {MaterialsService} from '../../features/lms/contracts';
export type LtiInstallationRegistration={id:string;ownerUserId:string;issuer:string;clientId:string;deploymentId:string;authorizationUrl:string;jwksUrl:string;materialsService:MaterialsService|null};
export type LtiResourceRegistration={installationId:string;kind:string;contextId:string;resourceLinkId:string;courseId:number|null;videoId:number|null;generation:number;youtubeVideoId:string|null;
  status:string|null;videoOwner:string|null;sourceType:string|null;actualYoutubeVideoId:string|null;courseOwner:string};
export type LtiLinkedRegistration={installationId:string;contextId:string;courseId:number;resourceLinkId:string|null};
export type LtiPlatform={issuer:string;clientId:string};
export interface LtiRegistrationRepository {
  snapshot(platform?:LtiPlatform):Promise<{installations:LtiInstallationRegistration[];resources:LtiResourceRegistration[];linked:LtiLinkedRegistration[]}>;
}
