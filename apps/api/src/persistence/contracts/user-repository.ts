import type { UserSecretsRepository } from "./user-secrets";

import type { CurrentUser } from '../../application/account-summary';
export type { CurrentUser } from '../../application/account-summary';

export interface UserRepository extends UserSecretsRepository {
  getCurrentUser(userId: string): Promise<CurrentUser | null>;
}
