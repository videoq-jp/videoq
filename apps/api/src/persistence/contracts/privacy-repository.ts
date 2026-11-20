import type { PrivacyInstallation, PrivacyRequest } from '../../application/privacy';
export interface PrivacyRepository{execute(installation:PrivacyInstallation,request:PrivacyRequest):Promise<unknown>;}
