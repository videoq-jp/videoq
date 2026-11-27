import { z } from "zod";
import { tagColorSchema } from "../schema";
import { textValueFailure } from '@videoq/domain/text-value';

const id = z.number().int().positive();
const name = z.string().min(1).max(50).superRefine((value, context) => {
  const error = textValueFailure(value);
  if (error) context.addIssue({ code: 'custom', message: error });
});

export const tagsInputSchemas = {
  "tags.list": z.object({
    limit: z.number().int().positive().max(100).default(100),
    offset: z.number().int().nonnegative().default(0),
  }).default({ limit: 100, offset: 0 }),
  "tags.get": z.object({ id }),
  "tags.create": z.object({ name, color: tagColorSchema.default("gray") }),
  "tags.update": z.object({
    id,
    name: name.optional(),
    color: tagColorSchema.optional(),
  }),
  "tags.delete": z.object({ id }),
};
