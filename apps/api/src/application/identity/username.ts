import { usernameSeed, usernameCandidate, fallbackUsername } from '../../domain/identity/username';
/** Existence checks only select a candidate; the DB unique constraint arbitrates races. */
export async function allocateUniqueUsername(usernameExists: (candidate: string) => Promise<boolean>, preferred: string, newId: () => string): Promise<string> {
  const seed = usernameSeed(preferred);
  for (let i = 0; i < 50; i++) {
    const candidate = usernameCandidate(seed, i);
    if (!await usernameExists(candidate)) return candidate;
  }
  return fallbackUsername(newId());
}
