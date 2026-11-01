import { withDb } from "../../db/pool";
import { createAuth, authBaseURL } from "../../lib/auth";
import { features } from "../../lib/deployment";
import { apiNotFound } from "../../shared/errors";
import type { Bindings } from "../../types/bindings";

/** Only called from admin-authorized handlers or the local operator CLI. */
export async function provisionOnpremUser(env: Bindings, input: {
  email: string; username: string; admin?: boolean;
}, headers?: Headers) {
  if (features(env).publicSignup) throw apiNotFound();
  input = { ...input, email: input.email.trim().toLowerCase(), username: input.username.trim().toLowerCase() };
  return withDb(env, db => db.transaction(async tx => {
    let activationUrl: string | undefined;
    // eslint-disable-next-line @typescript-eslint/require-await -- Preserve the asynchronous interface and rejection semantics.
    const auth = createAuth(env, tx, "full", { passwordReset: async ({ url }) => { activationUrl = url; } });
    // A random credential is never returned. The user chooses their password
    // through Better Auth's short-lived, single-use reset token instead.
    const { user } = await auth.api.createUser({ headers, body: {
      email: input.email, name: input.username, role: input.admin ? "admin" : "user",
      password: Array.from(crypto.getRandomValues(new Uint8Array(32)), value => value.toString(16).padStart(2, "0")).join(""),
      data: { username: input.username, displayUsername: input.username, emailVerified: true },
    } });
    await auth.api.requestPasswordReset({ body: { email: input.email, redirectTo: `${authBaseURL(env)}/reset-password` } });
    if (!activationUrl) throw new Error("Could not create an account activation link");
    return { id: user.id, username: input.username, email: user.email, activation_url: activationUrl };
  }));
}

export async function resetOnpremUserAccess(env: Bindings, id: string) {
  if (features(env).publicSignup) throw apiNotFound();
  return withDb(env, async db => {
    const { users } = await import("../../db/schema");
    const { eq } = await import("drizzle-orm");
    const [user] = await db.select({ email: users.email }).from(users).where(eq(users.id, id)).limit(1);
    if (!user) throw apiNotFound("User not found");
    let activationUrl: string | undefined;
    // eslint-disable-next-line @typescript-eslint/require-await -- Preserve the asynchronous interface and rejection semantics.
    const auth = createAuth(env, db, "full", { passwordReset: async ({ url }) => { activationUrl = url; } });
    await auth.api.requestPasswordReset({ body: { email: user.email, redirectTo: `${authBaseURL(env)}/reset-password` } });
    if (!activationUrl) throw new Error("Could not create an account activation link");
    return { activation_url: activationUrl };
  });
}
