import { z } from 'zod';

// The deployed legacy adapter name is part of the existing registration format.
export const moodleAuthorityKind = 'moodle' as const;
export const moodleAuthoritySchema = z.literal(moodleAuthorityKind);
