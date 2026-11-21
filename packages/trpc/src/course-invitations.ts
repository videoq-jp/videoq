import { z } from "zod";
import { normalizeInvitationEmail } from "@videoq/domain/course-invitations";

export * from "@videoq/domain/course-invitations";

/** Parse each recipient separately so one invalid address does not reject a batch. */
export const invitationEmailSchema = z.string().trim().toLowerCase().pipe(z.email().max(254))
  .refine(email => normalizeInvitationEmail(email) !== null);

export function isValidInvitationEmail(email: string): boolean {
  return invitationEmailSchema.safeParse(email).success;
}
