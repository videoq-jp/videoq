import { ApplicationError, type FailureKind } from './errors';

export type ScenarioStep<Output> =
  | { output: Output }
  | { failure: { kind: FailureKind; code: string; message: string } };
export type ScenarioSnapshot<Outputs extends Record<string, unknown>> = {
  revision: string;
  repeatLast: boolean;
  cases: Partial<{ [Name in keyof Outputs]: readonly ScenarioStep<Outputs[Name]>[] }>;
};

/** A stub is an input port implementation, not a database or HTTP mock.
 * Loading, validation and cloning are supplied by adapters. Reserve a step
 * synchronously after loading, so concurrent callers cannot reuse one step.
 */
export function createScenarioRunner<Outputs extends Record<string, unknown>>(
  load: () => Promise<ScenarioSnapshot<Outputs>>,
  copy: <Value>(value: Value) => Value,
) {
  let revision: string | undefined;
  const positions = new Map<keyof Outputs, number>();
  return {
    async execute<Name extends keyof Outputs & string>(name: Name): Promise<Outputs[Name]> {
      const snapshot = await load();
      if (revision !== snapshot.revision) {
        positions.clear();
        revision = snapshot.revision;
      }
      const steps = Object.hasOwn(snapshot.cases, name) ? snapshot.cases[name] : undefined;
      if (!steps?.length) throw new ApplicationError('unavailable', 'SCENARIO_MISSING', `No scenario for ${name}`);
      const index = positions.get(name) ?? 0;
      if (index >= steps.length && !snapshot.repeatLast) {
        throw new ApplicationError('conflict', 'SCENARIO_EXHAUSTED', `Scenario exhausted for ${name}`);
      }
      // Saturate the counter to bound its representation even in long sessions.
      positions.set(name, Math.min(index + 1, steps.length));
      const step = steps[Math.min(index, steps.length - 1)];
      if ('failure' in step) {
        throw new ApplicationError(step.failure.kind, step.failure.code, step.failure.message);
      }
      return copy(step.output);
    },
  };
}
