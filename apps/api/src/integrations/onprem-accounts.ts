import { eq } from 'drizzle-orm';
import { withDb, type Db } from '../db/pool';
import { users } from '../db/schema';
import { createAuth } from '../persistence/postgres/auth';
import { authBaseURL } from '../lib/auth';
import { features } from '../lib/deployment';
import { asApiError } from '../shared/errors';
import { createOnpremAccountService, type OnpremAccountSession, type ProvisionOnpremAccount } from '../application/onprem-accounts';
import type { Bindings } from '../types/bindings';

/** Bind provider calls to the caller's connection/transaction, never a new one. */
function accountSession(env: Bindings, db: Db, headers?: Headers): OnpremAccountSession {
  let activationUrl: string | undefined;
  let auth: ReturnType<typeof createAuth> | undefined;
  const provider = () => auth ??= createAuth(env, db, 'full', {
    // eslint-disable-next-line @typescript-eslint/require-await -- Provider expects asynchronous delivery.
    passwordReset: async ({ url }) => { activationUrl = url; },
  });
  return {
    async create(input) {
      const { user } = await provider().api.createUser({ headers, body: {
        email: input.email, name: input.username, role: input.role,
        password: Array.from(crypto.getRandomValues(new Uint8Array(32)), value => value.toString(16).padStart(2, '0')).join(''),
        data: { username: input.username, displayUsername: input.username, emailVerified: true },
      } });
      return { id: user.id, email: user.email };
    },
    async findEmail(id) {
      const [user] = await db.select({ email: users.email }).from(users).where(eq(users.id, id)).limit(1);
      return user?.email ?? null;
    },
    async requestActivation(email) {
      activationUrl = undefined;
      await provider().api.requestPasswordReset({ body: { email, redirectTo: `${authBaseURL(env)}/reset-password` } });
      return activationUrl;
    },
  };
}

function accounts(env: Bindings, headers?: Headers) {
  return createOnpremAccountService({
    enabled: !features(env).publicSignup,
    transaction: work => withDb(env, db => db.transaction(tx => work(accountSession(env, tx, headers)))),
    session: work => withDb(env, db => work(accountSession(env, db, headers))),
  });
}

/** Existing transports and the operator CLI retain their public error shape. */
export async function provisionOnpremUser(env: Bindings, input: ProvisionOnpremAccount, headers?: Headers) {
  try { return await accounts(env, headers).provision(input); }
  catch (error) { throw asApiError(error) ?? error; }
}
export async function resetOnpremUserAccess(env: Bindings, id: string) {
  try { return await accounts(env).resetAccess(id); }
  catch (error) { throw asApiError(error) ?? error; }
}
