import { z } from "zod";

// Only a fresh, authenticated Moodle access response can grant these permissions.
// Older plugins and static LTI registrations keep their existing chat access.
// Unknown future capabilities are ignored; only explicitly recognized booleans
// can grant access. This lets companion and backend releases be upgraded apart.
export const coursePermissionsSchema = z.object({
  manageOwnHistory: z.boolean().default(false),
  viewTranscript: z.boolean().default(false),
  viewQa: z.boolean().default(false),
  postQa: z.boolean().default(false),
  voteQa: z.boolean().default(false),
  deleteOwnQa: z.boolean().default(false),
  moderateQa: z.boolean().default(false),
  instructorQa: z.boolean().default(false),
});
export type CoursePermissions = z.infer<typeof coursePermissionsSchema>;
export const deniedCoursePermissions: CoursePermissions = Object.freeze(coursePermissionsSchema.parse({}));
