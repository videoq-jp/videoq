import { createCredentialRepository } from '../persistence/factory';
import { createCredentialService } from '../features/lti/credential-service';
import { sessionRecord } from '../features/lti/protocol';
import { asApiError } from '../shared/errors';
import type { Bindings } from '../types/bindings';

async function service(env: Bindings) {
  return createCredentialService({
    repository: await createCredentialRepository(env), now: Date.now,
    decodeSession: payload => {
      const parsed = sessionRecord.safeParse(payload);
      return parsed.success ? parsed.data : null;
    },
  });
}
export async function putCredential(env: Bindings, id: string, kind: string, payload: Record<string, unknown>, seconds: number) {
  await (await service(env)).put(id, kind, payload, seconds);
}
export async function readCredential(env: Bindings, id: string, kind: string) { return (await service(env)).read(id, kind); }
export async function recordScopeVideos(env: Bindings, id: string, ids: number[]) { return (await service(env)).recordScopeVideos(id, ids); }
export async function consumeLogin(env: Bindings, id: string) { return (await service(env)).consume(id, 'login'); }
export async function consumeCredential(env: Bindings, id: string, kind: string) { return (await service(env)).consume(id, kind); }
export async function pruneLtiCredentials(env: Bindings) { await (await service(env)).prune(); }
export async function replaceCredentialPayload(env: Bindings, id: string, kind: string, payload: Record<string, unknown>) {
  return (await service(env)).replacePayload(id, kind, payload);
}
export async function putLtiFeedback(env: Bindings, id: string, sessionHash: string, courseId: number, logId: number) {
  try { await (await service(env)).putFeedback(id, sessionHash, courseId, logId); }
  catch (error) { throw asApiError(error) ?? error; }
}
