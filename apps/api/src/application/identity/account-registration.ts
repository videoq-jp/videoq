import { accountWithDefaults, registrationUsername, type RegistrationInput } from '../../domain/identity/account-registration';
import type { SignupQuotaDefaults } from '../../domain/billing/signup-quota';
import { allocateUniqueUsername } from './username';
export async function initializeAccount<User extends RegistrationInput>(user: User, quota: SignupQuotaDefaults, deps: {usernameExists(candidate: string): Promise<boolean>; newId(): string}) {
  const username = registrationUsername(user) ?? await allocateUniqueUsername(candidate => deps.usernameExists(candidate), typeof user.email === 'string' ? user.email : 'user', () => deps.newId());
  return accountWithDefaults(user, quota, username);
}
