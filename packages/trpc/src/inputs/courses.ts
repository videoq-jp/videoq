import { z } from "zod";

const id = z.number().int().positive();

export const coursesInputSchemas = {
  "courses.list": z.object({
    limit: z.number().int().positive().max(100).default(24),
    cursor: z.number().int().nonnegative().optional(),
  }),
  "courses.get": z.object({ id }),
  "courses.shared": z.object({ slug: z.string().min(1).max(255) }),
  "courses.create": z.object({
    name: z.string().min(1).max(255),
    description: z.string().default(""),
  }),
  "courses.update": z.object({
    id,
    name: z.string().min(1).max(255).optional(),
    description: z.string().optional(),
  }),
  "courses.delete": z.object({ id }),
  "courses.reorder": z.object({ courseIds: z.array(id).min(1) }),
  "courses.createShare": z.object({ id, shareSlug: z.string().min(1) }),
  "courses.deleteShare": z.object({ id }),
  "courseMemberships.invite": z.object({
    courseId: id,
    // Keep syntax errors per recipient; the workflow uses invitationEmailSchema.safeParse.
    emails: z.array(z.string().max(1024)).min(1).max(100),
  }),
  "courseMemberships.participants": z.object({ courseId: id }),
  "courseMemberships.preview": z.object({ token: z.string().min(1).max(256) }),
  "courseMemberships.accept": z.object({ token: z.string().min(1).max(256) }),
  "courseMemberships.decline": z.object({ token: z.string().min(1).max(256) }),
  "courseMemberships.resend": z.object({ courseId: id, invitationId: id }),
  "courseMemberships.revoke": z.object({ courseId: id, invitationId: id }),
  "courseMemberships.removeMember": z.object({ courseId: id, userId: z.string().min(1) }),
  "courseMemberships.leave": z.object({ courseId: id }),
  "memberships.addTags": z.object({ videoId: id, tagIds: z.array(id).min(1) }),
  "memberships.removeTag": z.object({ videoId: id, tagId: id }),
  "memberships.reorderVideos": z.object({ courseId: id, videoIds: z.array(id) }),
  "memberships.addVideos": z.object({ courseId: id, videoIds: z.array(id).min(1) }),
  "memberships.addVideo": z.object({ courseId: id, videoId: id }),
  "memberships.removeVideo": z.object({ courseId: id, videoId: id }),
};
