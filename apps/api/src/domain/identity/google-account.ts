
export type GoogleAccountIdentity = {
  email?: unknown; displayName?: unknown; hostedDomain?: unknown; verifiedEmail?: unknown; image?: unknown;
};

/** Only Gmail and hosted Workspace claims establish present mailbox ownership.
 * Historical verification of a third-party address still needs local approval. */
export function googleAccountFacts(identity: GoogleAccountIdentity) {
  const email = typeof identity.email === 'string' ? identity.email : '';
  const authoritativeEmail = email.toLowerCase().endsWith('@gmail.com') ||
    (typeof identity.hostedDomain === 'string' && identity.hostedDomain.trim().length > 0);
  const preferred = typeof identity.displayName === 'string' && identity.displayName.trim()
    ? identity.displayName.trim() : email;
  return { email, preferred, authoritativeEmail };
}
export function googleAccountProfile(identity: GoogleAccountIdentity, allocated: string) {
  const { email, preferred, authoritativeEmail } = googleAccountFacts(identity);
  return {
    name: preferred || allocated, email, emailVerified: identity.verifiedEmail === true && authoritativeEmail,
    image: typeof identity.image === 'string' ? identity.image : undefined,
    username: allocated, displayUsername: allocated,
  };
}
