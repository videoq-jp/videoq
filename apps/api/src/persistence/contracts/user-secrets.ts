/**
 * User-owned Search API credential operations. Values are encrypted before
 * reaching persistence; plaintext and ciphertext are never returned by reads.
 */
export interface UserSecretsRepository {
  /** null means the user does not exist; false includes null/empty storage. */
  getSearchApiKeyStatus(userId: string): Promise<boolean | null>;
  /** false means the user does not exist. null removes the stored credential. */
  setSearchApiKey(userId: string, encryptedValue: string | null): Promise<boolean>;
}
