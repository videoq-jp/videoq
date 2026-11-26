import type { PrivacyInstallation, PrivacyRequest } from '../../domain/lms/privacy';
export type PrivacyRegistration=PrivacyInstallation&{jwksUrl:string};
export interface PrivacyAuthorizationRepository{
 findInstallation(identity:{issuer:string;clientId:string;deploymentId:string}):Promise<PrivacyRegistration|null>;
 consumeNonce(registration:PrivacyRegistration,nonce:string,action:PrivacyRequest['action'],expiresAt:Date):Promise<boolean>;
}
