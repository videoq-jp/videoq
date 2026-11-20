import type { UserSecretsRepository } from '../../persistence/contracts/user-secrets';

export function createAccountCredentialService(deps: {
  actorId(): string;
  encrypt(plaintext: string): Promise<string>;
  repository: UserSecretsRepository;
}) {
  return {
    status() { return deps.repository.getSearchApiKeyStatus(deps.actorId()); },
    async save(plaintext: string) {
      const encrypted = await deps.encrypt(plaintext);
      return deps.repository.setSearchApiKey(deps.actorId(), encrypted);
    },
    remove() { return deps.repository.setSearchApiKey(deps.actorId(), null); },
  };
}
