import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { UserSecretsRepository } from "../../../src/persistence/contracts/user-secrets";

/** Each backend supplies isolated persisted fixtures, not a mocked repository. */
export interface UserSecretsFixture {
  repository: UserSecretsRepository;
  createUser(id: string, encryptedValue: string | null): Promise<void>;
  readStoredCredential(id: string): Promise<string | null>;
  dispose(): Promise<void>;
}

export function userSecretsContract(
  backend: string,
  createFixture: () => Promise<UserSecretsFixture>,
): void {
  describe(`${backend}: UserSecretsRepository contract`, () => {
    let fixture: UserSecretsFixture | undefined;
    beforeEach(async () => { fixture = await createFixture(); });
    afterEach(async () => { await fixture?.dispose(); fixture = undefined; });
    const current = () => {
      if (!fixture) throw new Error("Persistence fixture was not initialized");
      return fixture;
    };

    it("distinguishes absent users from users without a credential", async () => {
      const { repository, createUser } = current();
      expect(await repository.getSearchApiKeyStatus("missing")).toBeNull();
      await createUser("owner", null);
      await createUser("empty", "");
      expect(await repository.getSearchApiKeyStatus("owner")).toBe(false);
      expect(await repository.getSearchApiKeyStatus("empty")).toBe(false);
      expect(await repository.setSearchApiKey("missing", "test-ciphertext")).toBe(false);
      expect(await repository.getSearchApiKeyStatus("missing")).toBeNull();
    });

    it("supports replacement, replay and removal without changing another user", async () => {
      const { repository, createUser, readStoredCredential } = current();
      await createUser("owner", null);
      await createUser("other", "other-test-ciphertext");
      for (const value of ["test-ciphertext", "test-ciphertext", "replacement"]) {
        expect(await repository.setSearchApiKey("owner", value)).toBe(true);
        expect(await repository.getSearchApiKeyStatus("owner")).toBe(true);
        expect(await readStoredCredential("owner")).toBe(value);
      }
      for (const value of [null, null, ""]) {
        expect(await repository.setSearchApiKey("owner", value)).toBe(true);
        expect(await repository.getSearchApiKeyStatus("owner")).toBe(false);
        expect(await readStoredCredential("owner")).toBe(value);
      }
      expect(await repository.getSearchApiKeyStatus("other")).toBe(true);
      expect(await readStoredCredential("other")).toBe("other-test-ciphertext");
    });
  });
}
