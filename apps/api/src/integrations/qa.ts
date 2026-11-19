import { createQaService } from '../features/qa/service';
import { createQaRepository } from '../persistence/factory';
import type { Bindings } from '../types/bindings';
import type { QaPrincipal, QaListInput, QaGetInput, QaCommand } from '../persistence/contracts/qa-repository';
export type { QaCommand, LtiQaPrincipal } from '../persistence/contracts/qa-repository';

export async function qaService(env: Bindings) {
  return createQaService(await createQaRepository(env));
}
export async function listQuestions(env: Bindings, principal: QaPrincipal, input: QaListInput) {
  return (await qaService(env)).listQuestions(principal, input);
}
export async function getQuestion(env: Bindings, principal: QaPrincipal, input: QaGetInput) {
  return (await qaService(env)).getQuestion(principal, input);
}
export async function mutate(env: Bindings, principal: Exclude<QaPrincipal, null>, command: QaCommand) {
  return (await qaService(env)).mutate(principal, command);
}
