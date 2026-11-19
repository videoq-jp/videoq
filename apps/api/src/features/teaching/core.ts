import type { TeachingTicket } from '../../application/teaching';

export interface TeachingDependencies {
  randomTicket(): string;
  digest(ticket: string): Promise<string>;
  validateTicket(input: unknown): TeachingTicket;
  saveTicket(id: string, input: TeachingTicket, ttlSeconds: number): Promise<void>;
  loadTicket(id: string): Promise<unknown>;
  connectionUrl(ticket: string): string;
  verifyAuthority(input: TeachingTicket): Promise<void>;
  connect(id: string, ownerUserId: string, input: TeachingTicket, selectedCourseId?: number): Promise<{ returnUrl: string; courseId: number }>;
}

/** External authority is rechecked before persistence atomically consumes the ticket. */
export function createTeachingService(deps: TeachingDependencies) {
  async function readTeachingTicket(ticket: string) {
    return deps.validateTicket(await deps.loadTicket(await deps.digest(ticket)));
  }
  return {
    async issueTeachingTicket(input: TeachingTicket) {
      const ticket = deps.randomTicket();
      await deps.saveTicket(await deps.digest(ticket), deps.validateTicket(input), 600);
      return { url: deps.connectionUrl(ticket) };
    },
    readTeachingTicket,
    async connectTeachingCourse(ticket: string, ownerUserId: string, selectedCourseId?: number) {
      const authority = await readTeachingTicket(ticket);
      await deps.verifyAuthority(authority);
      return deps.connect(await deps.digest(ticket), ownerUserId, authority, selectedCourseId);
    },
  };
}
