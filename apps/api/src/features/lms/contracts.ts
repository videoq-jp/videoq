import { z } from 'zod';

/** Connector identities are opaque. Never coerce, trim or case-fold a subject. */
export const lmsIdentity = z.string().min(1).max(255);
// SHA-1 remains a supported revision identifier for existing Moodle exports.
// Other connectors can supply a SHA-256 file digest without translating it.
export const sourceRevision = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/);

const httpsEndpoint = z.url().max(2048).refine(value => {
  const url = new URL(value);
  return url.protocol === 'https:' && !url.username && !url.password && !url.hash;
});
export const materialsServiceSchema = z.object({ tokenEndpoint: httpsEndpoint, endpoint: httpsEndpoint }).strict();
export type MaterialsService = z.infer<typeof materialsServiceSchema>;
export const materialManagementSchema = z.object({ generation: z.number().int().positive().safe() }).strict();
export const courseEntryAccessSchema = z.object({ generation: z.number().int().positive().safe() }).strict();

/** Only a fresh response from the registered authority can grant capabilities. */
export const coursePermissionsSchema = z.object({
  manageContent: z.boolean().default(false),
  manageOwnHistory: z.boolean().default(false),
  viewTranscript: z.boolean().default(false),
  viewReports: z.boolean().optional(),
  viewQa: z.boolean().default(false),
  postQa: z.boolean().default(false),
  voteQa: z.boolean().default(false),
  deleteOwnQa: z.boolean().default(false),
  moderateQa: z.boolean().default(false),
  instructorQa: z.boolean().default(false),
});
export type CoursePermissions = z.infer<typeof coursePermissionsSchema>;
export const deniedCoursePermissions: CoursePermissions = Object.freeze(coursePermissionsSchema.parse({}));

const authorityResource = z.object({
  resourceLinkId: lmsIdentity, lesson: lmsIdentity, title: z.string().max(500),
  generation: z.number().int().positive().safe().optional(),
  learning: z.boolean().optional(), management: materialManagementSchema.optional(),
});
// Legacy authority responses may omit externalId and include extension fields.
export const courseAuthorityResponse = z.object({
  contextId: lmsIdentity, resourceLinkId: lmsIdentity,
  permissions: coursePermissionsSchema.optional(), courseEntry: courseEntryAccessSchema.optional(),
  resources: z.array(authorityResource).max(1000),
});
export const materialsAccessResponse = courseAuthorityResponse.extend({
  resources: z.array(authorityResource.extend({ externalId: lmsIdentity }).strict()).max(1000),
}).strict();
export type CourseAuthorityResponse = z.infer<typeof courseAuthorityResponse>;
