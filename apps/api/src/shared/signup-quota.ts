import { features } from '../lib/deployment';
import type { Bindings } from '../types/bindings';
import { resolveSignupQuotaDefaults as resolve } from '../domain/billing/signup-quota';
export { parseNullableLimit, type SignupQuotaDefaults } from '../domain/billing/signup-quota';

export function resolveSignupQuotaDefaults(env: Pick<Bindings, 'RUNTIME' | 'DEPLOYMENT_EDITION'> & {
  DEFAULT_MONTHLY_UPLOAD_LIMIT_GB?: string; MAX_VIDEO_UPLOAD_SIZE_MB?: string;
  DEFAULT_STORAGE_LIMIT_GB?: string; DEFAULT_PROCESSING_LIMIT_MINUTES?: string; DEFAULT_AI_ANSWERS_LIMIT?: string;
}) {
  return resolve(features(env).billing, {
    monthlyUploadLimitGb: env.DEFAULT_MONTHLY_UPLOAD_LIMIT_GB, storageLimitGb: env.DEFAULT_STORAGE_LIMIT_GB,
    processingLimitMinutes: env.DEFAULT_PROCESSING_LIMIT_MINUTES, aiAnswersLimit: env.DEFAULT_AI_ANSWERS_LIMIT,
  });
}
