import type {z} from 'zod';
import type {PrivacyInstallation,privacyRequest} from '../../shared/privacy';
export interface PrivacyRepository{execute(installation:PrivacyInstallation,request:z.infer<typeof privacyRequest>):Promise<unknown>;}
