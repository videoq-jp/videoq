import { z } from 'zod';

/** Public LTI registration identifiers select context; they grant no authority. */
export const moodleManagementRequest = z.object({
  issuer: z.string().min(1).max(2048).refine(value => {
    try {
      const url = new URL(value);
      return url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash && !/[\s\\]/.test(value);
    } catch { return false; }
  }).transform(value => value.replace(/\/+$/, '')),
  clientId: z.string().min(1).max(255),
  deploymentId: z.string().regex(/^[1-9][0-9]{0,17}$/),
}).strict();

export const moodleManagementContext = z.object({
  connection: z.object({ owned: z.boolean(), active: z.boolean().nullable() }).strict(),
  permissions: z.object({ account: z.boolean(), billing: z.boolean(), systemAdmin: z.boolean() }).strict(),
}).strict();

export function parseMoodleManagementSearch(search: string) {
  if (search.length > 8192) return null;
  const params = new URLSearchParams(search);
  if (params.size !== 3 || ['issuer', 'clientId', 'deploymentId'].some(name => params.getAll(name).length !== 1)) return null;
  const result = moodleManagementRequest.safeParse(Object.fromEntries(params));
  return result.success ? result.data : null;
}
