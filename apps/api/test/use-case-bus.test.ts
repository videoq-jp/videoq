import { expect, it } from 'vitest';
import { createUseCaseBus } from '../src/application/use-case-bus';
import { createScenarioRunner } from '../src/application/scenario';
import { ApplicationError } from '../src/application/errors';

it('binds alternative implementations without changing the caller and freezes registration', async () => {
  const handlers = { greet: async (name: string) => ({ text: `Hello ${name}` }) };
  const real = createUseCaseBus(handlers);
  const stub = createUseCaseBus({ greet: async (_name: string) => ({ text: 'fixture' }) });
  handlers.greet = async () => ({ text: 'mutated registry' });
  expect(await real.execute('greet', 'student')).toEqual({ text: 'Hello student' });
  expect(await stub.execute('greet', 'student')).toEqual({ text: 'fixture' });
  await expect(real.execute('toString' as 'greet', 'student')).rejects.toThrow('Unregistered use case');
});
it('propagates application errors unchanged through the input port', async () => {
  const error = new ApplicationError('conflict', 'BUSY', 'Try again');
  const bus = createUseCaseBus({ save: async () => { throw error; } });
  await expect(bus.execute('save')).rejects.toBe(error);
});
it('reserves ordered stub outcomes under concurrency, including failures', async () => {
  const runner = createScenarioRunner<{ save: { id: number } }>(async () => ({ revision: '1', repeatLast: false,
    cases: { save: [{ output: { id: 1 } }, { failure: { kind: 'conflict', code: 'BUSY', message: 'Busy' } }, { output: { id: 3 } }] } }), structuredClone);
  const results = await Promise.allSettled([runner.execute('save'), runner.execute('save'), runner.execute('save')]);
  expect(results[0]).toEqual({ status: 'fulfilled', value: { id: 1 } });
  expect(results[1]).toMatchObject({ status: 'rejected', reason: { code: 'BUSY' } });
  expect(results[2]).toEqual({ status: 'fulfilled', value: { id: 3 } });
  await expect(runner.execute('save')).rejects.toMatchObject({ code: 'SCENARIO_EXHAUSTED' });
});
it('reloads revisions, isolates compositions, copies results and fails on missing scenarios', async () => {
  let revision = '1';
  const load = async () => ({ revision, repeatLast: true, cases: { read: [{ output: { id: 1 } }, { output: { id: 2 } }] } });
  const first = createScenarioRunner(load, structuredClone);
  const second = createScenarioRunner(load, structuredClone);
  (await first.execute('read')).id = 99;
  expect(await first.execute('read')).toEqual({ id: 2 });
  expect(await second.execute('read')).toEqual({ id: 1 });
  revision = '2';
  expect(await first.execute('read')).toEqual({ id: 1 });
  await expect(first.execute('constructor' as 'read')).rejects.toMatchObject({ code: 'SCENARIO_MISSING' });
});
