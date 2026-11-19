import type { QaRepository, QaPrincipal, QaListInput, QaGetInput, QaCommand } from '../../persistence/contracts/qa-repository';

/** Runtime composition belongs to integrations; callers supply the persistence capability. */
export function createQaService(repository: QaRepository) {
  return {
    listQuestions: (principal: QaPrincipal, input: QaListInput) => repository.list(principal, input),
    getQuestion: (principal: QaPrincipal, input: QaGetInput) => repository.get(principal, input),
    mutate: (principal: Exclude<QaPrincipal, null>, command: QaCommand) => repository.mutate(principal, command),
  };
}
