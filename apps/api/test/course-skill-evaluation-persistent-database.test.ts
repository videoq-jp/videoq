import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { openPersistentEvaluationDatabase } from '../scripts/course-skill-evaluation/persistent-database';

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true }))); });
async function directory() { const path = await mkdtemp(join(tmpdir(), 'videoq-persistent-evaluation-')); directories.push(path); return path; }

test('preserves publication identity across runtime restarts without reseeding', async () => {
  const path = await directory();
  let initializations = 0;
  const options = { directory: path, inputHash: 'a'.repeat(64), initialize: async (db: D1Database) => {
    initializations++;
    await db.prepare('CREATE TABLE publication_identity_probe(id TEXT PRIMARY KEY)').run();
    await db.prepare('INSERT INTO publication_identity_probe VALUES(?)').bind('immutable-publication-id').run();
  } };
  const first = await openPersistentEvaluationDatabase(options);
  expect(first.resumed).toBe(false);
  await expect(openPersistentEvaluationDatabase(options)).rejects.toThrow('ALREADY_OPEN');
  await first.dispose();
  const second = await openPersistentEvaluationDatabase(options);
  try {
    expect(second.resumed).toBe(true);
    expect(initializations).toBe(1);
    expect(await second.database.prepare('SELECT id FROM publication_identity_probe').first('id')).toBe('immutable-publication-id');
  } finally { await second.dispose(); }
  await expect(openPersistentEvaluationDatabase({ ...options, inputHash: 'b'.repeat(64) })).rejects.toThrow('INPUTS_CHANGED');
});

test('refuses partial initialization instead of repeating writes', async () => {
  const options = { directory: await directory(), inputHash: 'c'.repeat(64), initialize: async () => { throw new Error('injected initialization failure'); } };
  await expect(openPersistentEvaluationDatabase(options)).rejects.toThrow('injected initialization failure');
  let retried = false;
  await expect(openPersistentEvaluationDatabase({ ...options, initialize: async () => { retried = true; } })).rejects.toThrow('INITIALIZATION_INCOMPLETE');
  expect(retried).toBe(false);
});
