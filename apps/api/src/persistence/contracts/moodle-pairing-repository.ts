import type {MaterialsService} from '../../features/lms/contracts';
export type PairingMode='legacy'|'materials';
export type PairingCodePayload={ownerUserId:string;moodleUrl:string;mode:PairingMode;codeChallenge?:string};
export type PairingExchangeInput={secret:string;issuer:string;clientId:string;deploymentId:string;mode:PairingMode;syncToken?:string;codeVerifier?:string;materialsService?:MaterialsService};
export interface MoodlePairingRepository {
  issue(input:{ownerUserId:string;ownerKey:string;codeHash:string;payload:PairingCodePayload;expiresAt:number}):Promise<void>;
  exchange(input:PairingExchangeInput,codeHash:string,receiptId:string):Promise<{installationId:string;ownerUserId:string}>;
}
