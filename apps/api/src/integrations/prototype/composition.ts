import { TRPCError } from '@trpc/server';
import { createUseCaseBus } from '../../application/use-case-bus';
import { createScenarioRunner } from '../../application/scenario';
import { createCourseService } from '../../features/courses/service';
import { createMemoryCourseRepository } from '../../persistence/memory/course-repository';
import { createCourseProcedures } from '../../trpc/handlers/course-procedures';
import { createRpcCaller, requireUserId } from '../../trpc/handlers/shared';
import { outputSchemas } from '@videoq/trpc/outputs';
import type { ProcedureHandlers, ProcedureName } from '@videoq/trpc';
import { createJsonScenarioSource } from './scenario-source';

export function createPrototypeComposition(options: { scenario: string; mode: 'memory' | 'stub'; now?: () => Date }) {
  const source = createJsonScenarioSource(options.scenario);
  const scenarios = createScenarioRunner(async () => (await source.load()).snapshot, structuredClone);
  const courseBus = createUseCaseBus(createCourseService(createMemoryCourseRepository({ now: options.now ?? (() => new Date()) })));
  // Every live procedure has a stub input port. Outputs are validated by the
  // source and again by the unchanged router. Missing fixtures fail explicitly.
  const stubHandlers = Object.fromEntries(Object.keys(outputSchemas).map(name =>
    [name, async () => scenarios.execute(name as ProcedureName)])) as unknown as ProcedureHandlers;
  return {
    source,
    async context() {
      const { document } = await source.load();
      const userId = document.session.userId;
      const handlers: ProcedureHandlers = options.mode === 'stub' ? stubHandlers : {
        ...stubHandlers,
        ...createCourseProcedures({ useCases: () => Promise.resolve(courseBus), userId: () => requireUserId(userId) }),
      };
      return { userId, assertAdmin: () => document.session.admin ? Promise.resolve()
        : Promise.reject(new TRPCError({ code: 'FORBIDDEN', message: 'Prototype administrator access is disabled' })), call: createRpcCaller(handlers) };
    },
  };
}
