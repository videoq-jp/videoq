import { z } from 'zod';
import type { Bindings } from '../../types/bindings';
import { hasSecretEncryptionKey } from '../../lib/secret-encryption';

const identifier = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
export const materialSchema = z.object({
  id: identifier, title: z.string().min(1).max(500),
  videoIds: z.array(z.number().int().positive().safe()).min(1).max(1000),
}).strict();
const schema = z.object({
  toolOrigin: z.url().refine(value => new URL(value).protocol === 'https:' && new URL(value).origin === value),
}).strict();
export type ClassroomConfig = z.infer<typeof schema>;
export type ClassroomCourse = { classroomCourseId: string; videoqCourseId: number; materials: z.infer<typeof materialSchema>[] };
export type ClassroomMaterial = z.infer<typeof materialSchema>;
export function classroomConfig(env: Bindings): ClassroomConfig | null {
  if (!env.CLASSROOM_CONFIG?.trim() || env.CLASSROOM_CONFIG.trim() === 'false') return null;
  if (!env.CLASSROOM_CLIENT_ID || !env.CLASSROOM_CLIENT_SECRET || !hasSecretEncryptionKey(env))
    throw new Error('Classroom OAuth credentials and secret encryption key are required');
  const parsed = schema.safeParse(JSON.parse(env.CLASSROOM_CONFIG));
  if (!parsed.success) throw new Error('Invalid CLASSROOM_CONFIG');
  return parsed.data;
}
export const launchSchema = z.object({
  courseId: identifier, itemId: identifier,
  itemType: z.enum(['courseWork', 'announcements', 'courseWorkMaterials']),
  attachmentId: identifier.optional(), addOnToken: z.string().min(1).max(4096).optional(),
  login_hint: z.string().min(1).max(255).optional(),
  view: z.enum(['discovery', 'teacher', 'student']),
}).strict().refine(value => value.view === 'discovery' ? !!value.addOnToken && !value.attachmentId : !!value.attachmentId);
export type ClassroomLaunch = z.infer<typeof launchSchema>;
export const classroomFeatures = { transcripts: true, qa: true, conversations: true, management: false, tags: false, reports: false };
