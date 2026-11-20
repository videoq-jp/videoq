import { allocateUniqueUsername } from './username';
import type { SignupQuotaDefaults } from './signup-quota';

type RegistrationInput = {
  username?: unknown; displayUsername?: unknown; name?: unknown; email: string;
};

/** Account defaults apply to every creation path, independent of auth provider. */
export async function initializeAccount<User extends RegistrationInput>(
  user: User, q: SignupQuotaDefaults,
  deps: { usernameExists: (candidate: string) => Promise<boolean>; newId: () => string },
) {
  let username =
    typeof user.username === "string" && user.username.trim()
      ? user.username.trim()
      : undefined;
  if (!username) {
    username = await allocateUniqueUsername(
      deps.usernameExists,
      typeof user.email === "string" ? user.email : "user",
      deps.newId,
    );
  }
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
