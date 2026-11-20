import { notFound } from './errors';

export type ProvisionOnpremAccount = { email: string; username: string; admin?: boolean };
export interface OnpremAccountSession {
  create(input: { email: string; username: string; role: 'admin' | 'user' }): Promise<{ id: string; email: string }>;
  findEmail(id: string): Promise<string | null>;
  requestActivation(email: string): Promise<string | undefined>;
}
export interface OnpremAccountDependencies {
  enabled: boolean;
  transaction<T>(work: (accounts: OnpremAccountSession) => Promise<T>): Promise<T>;
  session<T>(work: (accounts: OnpremAccountSession) => Promise<T>): Promise<T>;
}

async function activation(accounts: OnpremAccountSession, email: string): Promise<string> {
  const url = await accounts.requestActivation(email);
  if (!url) throw new Error('Could not create an account activation link');
  return url;
}

/** The adapter keeps creation and activation-token issuance on one transaction.
 * Password generation and token handling remain inside the account provider. */
export function createOnpremAccountService(deps: OnpremAccountDependencies) {
  return {
    async provision(input: ProvisionOnpremAccount) {
      if (!deps.enabled) throw notFound();
      const email = input.email.trim().toLowerCase();
      const username = input.username.trim().toLowerCase();
      return deps.transaction(async accounts => {
        const user = await accounts.create({ email, username, role: input.admin ? 'admin' : 'user' });
        const activationUrl = await activation(accounts, email);
        return { id: user.id, username, email: user.email, activation_url: activationUrl };
      });
    },
    async resetAccess(id: string) {
      if (!deps.enabled) throw notFound();
      return deps.session(async accounts => {
        const email = await accounts.findEmail(id);
        if (email === null) throw notFound('User not found');
        return { activation_url: await activation(accounts, email) };
      });
    },
  };
}
