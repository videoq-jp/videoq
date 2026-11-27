import type { SignupQuotaDefaults } from '../billing/signup-quota';

export type RegistrationInput = {
  username?: unknown; displayUsername?: unknown; name?: unknown; email: string;
};

export function registrationUsername(user: RegistrationInput): string | undefined {
  return typeof user.username === 'string' && user.username.trim() ? user.username.trim() : undefined;
}

/** Account defaults are pure facts, independent of the auth provider. */
export function accountWithDefaults<User extends RegistrationInput>(user: User, q: SignupQuotaDefaults, username: string) {
  const displayUsername =
    typeof user.displayUsername === "string" && user.displayUsername.trim()
      ? user.displayUsername
      : username;
  const name =
    (typeof user.name === "string" && user.name) ||
    username ||
    user.email;
  return {
    ...user,
    name,
    username,
    displayUsername,
    maxVideoUploadSizeMb: q.maxVideoUploadSizeMb,
    aiAnswersLimit: q.aiAnswersLimit,
    processingLimitMinutes: q.processingLimitMinutes,
    storageLimitGb: q.storageLimitGb,
    monthlyUploadLimitGb: q.monthlyUploadLimitGb,
    isOverQuota: false,
    usedAiAnswers: 0,
    usedProcessingSeconds: 0,
    usedStorageBytes: 0,
    firstName: "",
    lastName: "",
    passwordResetRequired: false,
  };
}
