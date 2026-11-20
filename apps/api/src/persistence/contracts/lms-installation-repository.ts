import type { ManagementIdentity, ManagementAccess } from "../../application/lms-management";
import type {ProvisionInstallation} from '../../application/lti-registration';
import type {MaterialsService} from '../../application/lti-registration';
export type InstallationRegistration=ProvisionInstallation & {syncTokenHash:string|null;materialsService?:MaterialsService};
export type InstallationGrant={id:string;issuer:string;clientId:string;deploymentId:string};
export interface LmsInstallationRepository {
  managementAccess(userId:string,identity:ManagementIdentity):Promise<ManagementAccess|null>;
  insert(registration:InstallationRegistration):Promise<void>;
  authenticate(tokenHash:string):Promise<InstallationGrant|null>;
  rotate(ownerUserId:string,installationId:string,tokenHash:string):Promise<string|null>;
  disconnect(ownerUserId:string,installationId:string):Promise<boolean>;
  listActive(ownerUserId:string):Promise<Array<{id:string;moodleUrl:string;active:boolean}>>;
}
