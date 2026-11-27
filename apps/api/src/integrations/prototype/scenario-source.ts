import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import { outputSchemas } from '@videoq/trpc/outputs';
import type { RpcOutputMap } from '@videoq/trpc';
import { ApplicationError } from '../../application/errors';
import type { ScenarioSnapshot } from '../../application/scenario';

const failure = z.object({ kind: z.enum(['validation', 'too_large', 'unauthorized', 'forbidden', 'not_found', 'conflict', 'unavailable']),
  code: z.string().min(1), message: z.string() }).strict();
const rawResponse = z.object({ status: z.number().int().min(200).max(599).default(200),
  headers: z.record(z.string(), z.string()).default({}), body: z.unknown().optional() }).strict();
const documentSchema = z.object({ version: z.literal(1), repeatLast: z.boolean().default(true),
  session: z.object({ userId: z.string().min(1).nullable(), admin: z.boolean().default(false) }).strict(),
  procedures: z.record(z.string(), z.array(z.union([
    z.object({ output: z.unknown() }).strict(), z.object({ failure }).strict(),
  ])).min(1)),
  http: z.record(z.string(), z.array(rawResponse).min(1)).default({}),
}).strict();
export type PrototypeDocument = z.output<typeof documentSchema>;
export type LoadedScenario = { document: PrototypeDocument; snapshot: ScenarioSnapshot<RpcOutputMap> };

/** Serialize reads so hot reload and concurrent requests see ordered revisions.
 * Every revision is fully validated before any configured step can execute.
 */
export function createJsonScenarioSource(path: string) {
  let pending: Promise<unknown> = Promise.resolve();
  let previousText: string | undefined;
  let previous: LoadedScenario | undefined;
  let revision = 0;
  return {
    load(): Promise<LoadedScenario> {
      const read = pending.then(async () => {
        const bytes = await readFile(path);
        if (bytes.length > 1024 * 1024) throw new Error('Scenario exceeds 1 MiB');
        const text = bytes.toString('utf8');
        if (text === previousText && previous) return previous;
        const document = documentSchema.parse(JSON.parse(text));
        const cases: Record<string, unknown> = {};
        for (const [name, steps] of Object.entries(document.procedures)) {
          if (!Object.hasOwn(outputSchemas, name)) throw new Error(`Unknown procedure: ${name}`);
          const schema = outputSchemas[name as keyof typeof outputSchemas];
          cases[name] = steps.map(step => 'failure' in step ? step : { output: schema.parse(step.output) });
        }
        for (const route of Object.keys(document.http)) {
          if (!/^(GET|HEAD|POST|PUT|PATCH|DELETE|OPTIONS) \/[^?#\s]*$/.test(route)) throw new Error(`Invalid HTTP scenario: ${route}`);
        }
        const value: LoadedScenario = { document, snapshot: { revision: String(++revision), repeatLast: document.repeatLast,
          cases } };
        previousText = text;
        previous = value;
        return value;
      }).catch(() => {
        throw new ApplicationError('unavailable', 'SCENARIO_INVALID', 'Invalid prototype scenario. Check the local JSON file.', undefined, true);
      });
      // A broken revision must not prevent the next corrected file from loading.
      pending = read.catch(() => undefined);
      return read;
    },
  };
}
