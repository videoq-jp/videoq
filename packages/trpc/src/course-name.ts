import { z } from 'zod';
import { normalizeCourseName } from '@videoq/domain/course-name';

export const courseNameSchema = z.string().trim().superRefine((value, ctx) => {
  const result = normalizeCourseName(value);
  if ('error' in result) {
    ctx.addIssue({ code: 'custom', message: result.error });
    return;
  }
});
