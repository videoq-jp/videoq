import { it, expect } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateSearchEvaluationInput } from '../../scripts/migrations/d1/search-evaluation';
const exec = promisify(execFile);

it('accepts Python-generated frozen query vectors in the actual paired-search input contract', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'videoq-query-contract-'));
  try {
    const worker = fileURLToPath(new URL('../../../worker/', import.meta.url));
    const python = existsSync(join(worker, '.venv/bin/python')) ? join(worker, '.venv/bin/python') : 'python3';
    const source = join(directory, 'questions.json'), output = join(directory, 'vectors.json');
    await writeFile(source, JSON.stringify({ version: 1, cohort: 'synthetic', corpusSha256: 'a'.repeat(64),
      embedding: { provider: 'openai', model: 'openai/text-embedding-3-small', profile: 'openai', dimensions: 1536,
        baseUrl: 'https://openrouter.ai/api/v1', authentication: 'configured' }, samples: 3,
      cases: [{ id: 'q1', question: '合成の代表質問 🌸', userId: 'owner', videoIds: [1, 2], limit: 20 },
        { id: 'q2', question: '合成の代表質問 🌸', userId: 'peer', videoIds: [3], limit: 10 }],
    }), { mode: 0o600 });
    const script = `import json,sys
from worker_python import search_evaluation as evaluation
calls=[]
def synthetic(texts,*,input_type):
 calls.append([len(texts),input_type])
 return [[1.0]+[0.0]*1535 for _ in texts]
evaluation.embed_texts=synthetic
summary=evaluation.prepare(evaluation.Path(sys.argv[1]),evaluation.Path(sys.argv[2]),execute=True)
assert calls==[[1,'query']]
assert not any(name in sys.modules for name in ['psycopg','worker_python.db','worker_python.sqs_enqueue','worker_python.lambda_handler','worker_python.job_execution'])
print(json.dumps({'synthetic_generation':True,'unique_query_calls':len(calls)}))`;
    const result = await exec(python, ['-c', script, source, output], { cwd: worker, timeout: 15000,
      env: { PATH: process.env.PATH, PYTHONPATH: worker, EMBEDDING_MODEL: 'openai/text-embedding-3-small',
        OPENAI_BASE_URL: 'https://openrouter.ai/api/v1', OPENROUTER_API_KEY: 'synthetic-contract-key' } });
    expect(JSON.parse(result.stdout)).toEqual({ synthetic_generation: true, unique_query_calls: 1 });
    const raw = await readFile(output, 'utf8');
    expect(raw).not.toContain('合成の代表質問');
    const input = validateSearchEvaluationInput(JSON.parse(raw));
    expect(input).toMatchObject({ version: 1, model: 'openai/text-embedding-3-small', dimensions: 1536, samples: 3 });
    expect(input.cases.map(request => [request.userId, request.videoIds, request.limit])).toEqual([['owner', [1, 2], 20], ['peer', [3], 10]]);
    expect(input.cases[0].queryEmbedding).toEqual(input.cases[1].queryEmbedding);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
