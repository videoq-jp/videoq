import type { CredentialRepository } from '../../persistence/contracts/credential-repository';
import { createLtiSessionProof } from '../../application/lti-session-proof';
import { forbidden } from '../../application/errors';

export interface CredentialDependencies {
  repository: CredentialRepository;
  now(): number;
  decodeSession(payload: Record<string, unknown> | null): { registrationId: string; subjectHash: string } | null;
}

export function createCredentialService(deps: CredentialDependencies) {
  const repository = deps.repository;
  return {
    put(id: string, kind: string, payload: Record<string, unknown>, seconds: number) {
      return repository.put(id, kind, payload, deps.now() + seconds * 1000);
    },
    read: (id: string, kind: string) => repository.read(id, kind),
    recordScopeVideos: (id: string, ids: number[]) => repository.recordScopeVideos(id, ids),
    consume: (id: string, kind: string) => repository.consume(id, kind),
    prune: () => repository.prune(),
    replacePayload: (id: string, kind: string, payload: Record<string, unknown>) => repository.replacePayload(id, kind, payload),
    async putFeedback(id: string, sessionHash: string, courseId: number, logId: number) {
      const session = deps.decodeSession(await repository.read(sessionHash, 'session'));
      if (!session) throw forbidden('The Moodle session is unavailable.');
      const proof = createLtiSessionProof(session, sessionHash);
      // The repository rechecks proof and ownership in the atomic write.
      await repository.putFeedback(id, proof, courseId, logId, deps.now() + 3600_000);
    },
  };
}
