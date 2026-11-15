import type {PrivacyInstallation,privacyRequest} from '../../shared/privacy';
import type {z} from 'zod';
export type PrivacyRegistration=PrivacyInstallation&{jwksUrl:string};
export interface PrivacyAuthorizationRepository{
 findInstallation(identity:{issuer:string;clientId:string;deploymentId:string}):Promise<PrivacyRegistration|null>;
 consumeNonce(registration:PrivacyRegistration,nonce:string,action:z.infer<typeof privacyRequest>['action'],expiresAt:Date):Promise<boolean>;
}
