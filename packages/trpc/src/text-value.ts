import { z } from 'zod';
import { textValueFailure } from '@videoq/domain/text-value';
/** Do not trim free text: description/transcript whitespace has meaning. */
export const textValueSchema = z.string().refine(value => textValueFailure(value) === null, 'Text must not contain NUL characters.');
