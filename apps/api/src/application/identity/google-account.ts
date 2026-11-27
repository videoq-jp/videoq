import { googleAccountFacts, googleAccountProfile, type GoogleAccountIdentity } from '../../domain/identity/google-account';
import { allocateUniqueUsername } from './username';
export async function createGoogleAccountProfile(identity: GoogleAccountIdentity, deps: {usernameExists(candidate: string): Promise<boolean>; newId(): string}) {
  const {email,preferred} = googleAccountFacts(identity);
  const username = await allocateUniqueUsername(candidate => deps.usernameExists(candidate), email || preferred, () => deps.newId());
  return googleAccountProfile(identity, username);
}
