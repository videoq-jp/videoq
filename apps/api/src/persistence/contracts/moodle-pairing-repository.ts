import type { PairingCodePayload, PairingExchangeInput } from '../../application/moodle-pairing';
export type { PairingMode, PairingCodePayload, PairingExchangeInput } from '../../application/moodle-pairing';
export interface MoodlePairingRepository {
  issue(input:{ownerUserId:string;ownerKey:string;codeHash:string;payload:PairingCodePayload;expiresAt:number}):Promise<void>;
  exchange(input:PairingExchangeInput,codeHash:string,receiptId:string):Promise<{installationId:string;ownerUserId:string}>;
}
