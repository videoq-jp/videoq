import { moodleAuthorityKind, moodleAuthoritySchema } from './providers/moodle/contracts';

// Existing token-based installations predate the common connector service.
export const defaultLegacyAuthority = moodleAuthorityKind;
export const legacyAuthoritySchema = moodleAuthoritySchema;
