import { createAccountCredentialService } from '../features/account/service';
import { encryptUserSecret } from '../lib/secret-encryption';
import { getSearchApiKeyStatus, setSearchApiKey } from '../repositories/user-repository';
import type { Bindings } from '../types/bindings';

export function accountCredentials(env: Bindings, actorId: () => string) {
  return createAccountCredentialService({
    actorId, encrypt: plaintext => encryptUserSecret(env, plaintext),
    repository: {
      getSearchApiKeyStatus: id => getSearchApiKeyStatus(env, id),
      setSearchApiKey: (id, encrypted) => setSearchApiKey(env, id, encrypted),
    },
  });
}
