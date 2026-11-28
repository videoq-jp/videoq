import type { QaRepository, QaPrincipal, QaListInput, QaGetInput, QaCommand } from '../../persistence/contracts/qa-repository';
import { textValueFailure } from '@videoq/domain/text-value';
import { validationFailure } from '../../application/errors';

/** Runtime composition belongs to integrations; callers supply the persistence capability. */
export function createQaService(repository: QaRepository) {
  return {
    listQuestions: (principal: QaPrincipal, input: QaListInput) => repository.list(principal, input),
    getQuestion: (principal: QaPrincipal, input: QaGetInput) => repository.get(principal, input),
    async mutate(principal: Exclude<QaPrincipal, null>, command: QaCommand) {
      const error = ('title' in command.input ? textValueFailure(command.input.title) : null)
        ?? ('body' in command.input ? textValueFailure(command.input.body) : null);
      if (error) throw validationFailure(error);
      return repository.mutate(principal, command);
    },
  };
}
