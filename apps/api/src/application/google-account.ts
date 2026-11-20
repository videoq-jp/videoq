import { allocateUniqueUsername } from './username';

export type GoogleAccountIdentity = {
  email?: unknown; displayName?: unknown; hostedDomain?: unknown; verifiedEmail?: unknown; image?: unknown;
};

/** Only Gmail and hosted Workspace claims establish present mailbox ownership.
 * Historical verification of a third-party address still needs local approval. */
export async function createGoogleAccountProfile(identity: GoogleAccountIdentity, deps: {
  usernameExists(candidate: string): Promise<boolean>;
  newId(): string;
}) {
  const email = typeof identity.email === 'string' ? identity.email : '';
  const authoritativeEmail = email.toLowerCase().endsWith('@gmail.com') ||
    (typeof identity.hostedDomain === 'string' && identity.hostedDomain.trim().length > 0);
  const preferred = typeof identity.displayName === 'string' && identity.displayName.trim()
    ? identity.displayName.trim() : email;
  const allocated = await allocateUniqueUsername(candidate => deps.usernameExists(candidate), email || preferred, () => deps.newId());
  return {
    name: preferred || allocated, email, emailVerified: identity.verifiedEmail === true && authoritativeEmail,
    image: typeof identity.image === 'string' ? identity.image : undefined,
    username: allocated, displayUsername: allocated,
  };
}
