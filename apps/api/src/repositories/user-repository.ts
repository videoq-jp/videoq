import type { Bindings } from "../types/bindings";
import { createUserRepository } from "../persistence/factory";
export type { CurrentUser } from "../persistence/contracts/user-repository";

export async function getCurrentUser(env: Bindings, userId: string) {
  return (await createUserRepository(env)).getCurrentUser(userId);
}
export async function getSearchApiKeyStatus(env: Bindings, userId: string): Promise<boolean | null> {
  return (await createUserRepository(env)).getSearchApiKeyStatus(userId);
}
export async function setSearchApiKey(env: Bindings, userId: string, encryptedValue: string | null): Promise<boolean> {
  return (await createUserRepository(env)).setSearchApiKey(userId, encryptedValue);
}
