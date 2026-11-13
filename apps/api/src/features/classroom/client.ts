import { z } from 'zod';
import type { ClassroomLaunch } from './config';

const apiOrigin = 'https://classroom.googleapis.com';
/** Fixed Google endpoints, bounded network time, no redirects or upstream error bodies in logs. */
export async function googleJson(url: URL, accessToken: string, body?: unknown): Promise<unknown> {
  if (url.origin !== apiOrigin) throw new Error('Invalid Classroom API origin');
  const response = await fetch(url, { method: body === undefined ? 'GET' : 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), redirect: 'error', signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw new Error('Classroom API request was denied');
  return response.json();
}
export function postUrl(launch: ClassroomLaunch, suffix: string): URL {
  return new URL(`/v1/courses/${encodeURIComponent(launch.courseId)}/${launch.itemType}/${encodeURIComponent(launch.itemId)}/${suffix}`, apiOrigin);
}
const contextSchema = z.object({ courseId: z.string(), itemId: z.string(),
  teacherContext: z.object({}).optional(), studentContext: z.object({ submissionId: z.string().optional() }).optional(),
});
export async function getContext(launch: ClassroomLaunch, token: string) {
  const url = postUrl(launch, 'addOnContext');
  if (launch.attachmentId) url.searchParams.set('attachmentId', launch.attachmentId);
  if (launch.addOnToken) url.searchParams.set('addOnToken', launch.addOnToken);
  const result = contextSchema.parse(await googleJson(url, token));
  if (result.courseId !== launch.courseId || result.itemId !== launch.itemId
    || !!result.teacherContext === !!result.studentContext
    || (launch.view !== 'student' && !result.teacherContext)) throw new Error('Classroom role was denied');
  return result;
}
export const attachmentSchema = z.object({ id: z.string().min(1), title: z.string(),
  teacherViewUri: z.object({ uri: z.url() }), studentViewUri: z.object({ uri: z.url() }),
});
export async function getAttachment(launch: ClassroomLaunch, token: string) {
  const result = attachmentSchema.parse(await googleJson(postUrl(launch, `addOnAttachments/${encodeURIComponent(launch.attachmentId!)}`), token));
  if (result.id !== launch.attachmentId) throw new Error('Classroom attachment mismatch');
  return result;
}
