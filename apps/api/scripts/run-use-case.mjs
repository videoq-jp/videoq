import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { z } from 'zod';
import { generatedUseCases } from '../src/integrations/generated/registry.ts';

const [name, inputText = '{}', fixturePath, callsText = '1'] = process.argv.slice(2);
if (!name || !Object.hasOwn(generatedUseCases, name) || !fixturePath) throw new Error('Usage: npm run use-case:run -- <registered-name> <input-json> <scenario.json> [calls]');
const calls = Number(callsText);
if (!Number.isInteger(calls) || calls < 1 || calls > 100) throw new Error('Calls must be between 1 and 100');
const definition = generatedUseCases[name];
const input = definition.input.parse(JSON.parse(inputText));
const schema = z.object({ version: z.literal(1), repeatLast: z.boolean(), cases: z.record(z.string(), z.array(z.union([
  z.object({ output: definition.output }).strict(),
  z.object({ failure: z.object({ kind: z.enum(['validation', 'too_large', 'unauthorized', 'forbidden', 'not_found', 'conflict', 'unavailable']), code: z.string(), message: z.string() }).strict() }).strict(),
])).min(1)) }).strict();
let previous, revision = 0;
const bus = definition.create({ mode: 'stub', load: async () => {
  const text = await readFile(resolve(fixturePath), 'utf8');
  if (text !== previous) { previous = text; revision++; }
  return { ...schema.parse(JSON.parse(text)), revision: String(revision) };
} });
for (let count = 0; count < calls; count++) console.log(JSON.stringify(await bus.execute(name, input)));
