import type { PrivacyInstallation, PrivacyRequest } from '../../domain/lms/privacy';
export interface PrivacyRepository{execute(installation:PrivacyInstallation,request:PrivacyRequest):Promise<unknown>;}
