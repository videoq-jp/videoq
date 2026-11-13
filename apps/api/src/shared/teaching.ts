import {z} from 'zod';
import {launchSchema} from '../features/classroom/config';
export const ticketSchema = z.object({ provider: z.enum(['moodle', 'classroom']), installationId: z.string().min(1),
  contextId: z.string().min(1), teacherSubject: z.string().min(1), teacherName: z.string().max(512),
  title: z.string().max(255), returnUrl: z.url(),
  resourceLinkId: z.string().optional(),
  classroomProof: z.object({ accountEnvelope: z.string(), launch: launchSchema }).optional() }).strict();
export type TeachingTicket = z.infer<typeof ticketSchema>;
