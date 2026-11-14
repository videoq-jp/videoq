import { createD1UserSecretsRepository } from "../../src/persistence/d1/user-secrets";
import { userSecretsContract } from "./contracts/user-secrets.contract";
import { createD1Fixture } from "./d1-fixture";

userSecretsContract("D1 (workerd)", async () => {
  const { database, dispose } = await createD1Fixture();
  return {
    repository: createD1UserSecretsRepository(database),
    createUser: async (id, encryptedValue) => {
      await database.prepare("INSERT INTO users (id, username, email, searchapi_api_key_encrypted, is_over_quota, used_ai_answers, used_processing_seconds, used_storage_bytes) VALUES (?, ?, ?, ?, 0, 0, 0, 0)")
        .bind(id, id, `${id}@example.test`, encryptedValue).run();
    },
    readStoredCredential: async id => {
      return database.prepare("SELECT searchapi_api_key_encrypted AS value FROM users WHERE id = ?")
        .bind(id).first<string | null>("value");
    },
    dispose,
  };
});
