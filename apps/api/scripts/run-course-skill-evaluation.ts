/** Explicit opt-in only; private configuration and a genuine owner decision required. */
import { parseArgs, promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { readFile, mkdtemp, rm, access } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { z } from 'zod';
import { readFrozenCourse, readOnlySearchTransport, createFrozenEvaluationEnvironment, sha256 } from './course-skill-evaluation/environment';
import { approvalSchema, importOwnerReviewedPackages, validateReviewedArtifactPackages } from './course-skill-evaluation/reviewed-import';
import { publicationVersionHashes, assertPublicationVersions } from './course-skill-evaluation/publications';
import { readLiveSourcePin } from './course-skill-evaluation/live-source';
import { evaluationCases } from './course-skill-evaluation/cases';
import { initializeCaseRepository } from './course-skill-evaluation/fixtures';
import { codexVersion } from './course-skill-evaluation/codex';
import { runComparisonCohort, type CohortManifest } from './course-skill-evaluation/cohort';
import { executeComparisonSlot } from './course-skill-evaluation/runner';

const path = z.string().min(1);
const configuration = z.object({
  courseId: z.number().int().positive(), accountId: z.string().regex(/^[a-f0-9]{32}$/), databaseId: z.string().uuid(), indexName: z.string().regex(/^[a-z0-9-]+$/),
  videosFile: path, runsFile: path, scenesFile: path, sourceFile: path, approvalFile: path, wranglerAuthFile: path,
  directory: path, bootstrapSource: path, seed: z.string().min(16), model: z.string().min(1), timeoutMs: z.number().int().min(1000).max(300000),
}).strict();
const { values } = parseArgs({ options: { run: { type: 'boolean' }, config: { type: 'string' }, 'max-trials': { type: 'string' } } });
try {
  if (!values.run) {
    console.info('Use --run --config PRIVATE_JSON --max-trials 1 to execute a bounded batch. Requires an explicit owner-approved local-only artifact record. Configuration fields: courseId, accountId, databaseId, indexName, videosFile, runsFile, scenesFile, sourceFile, approvalFile, wranglerAuthFile, directory, bootstrapSource, seed (at least 16 characters), model, timeoutMs. Reuses the same private local DB and immutable comparison manifest. A STOP file in directory stops before the next trial. No production writes or deployment.');
  } else {
    if (!values.config) throw new Error('CONFIGURATION_REQUIRED');
    const rawConfig = await readFile(values.config, 'utf8'), config = configuration.parse(JSON.parse(rawConfig));
    const maxTrials = Number(values['max-trials'] ?? '1');
    if (!Number.isSafeInteger(maxTrials) || maxTrials < 1 || maxTrials > 60) throw new Error('INVALID_BATCH_SIZE');
    // A pending decision cannot start a database, external API call or client.
    const approvalRaw = await readFile(config.approvalFile, 'utf8'), approval = approvalSchema.parse(JSON.parse(approvalRaw));
    if (approval.courseId !== config.courseId) throw new Error('REVIEWED_COURSE_MISMATCH');
    const git = promisify(execFile);
    const implementationPin = async () => {
      if ((await git('git', ['status', '--porcelain', '--untracked-files=normal'])).stdout.trim()) throw new Error('EVALUATION_REQUIRES_COMMITTED_IMPLEMENTATION');
      return sha256((await git('git', ['rev-parse', 'HEAD'])).stdout.trim());
    };
    const initialImplementation = await implementationPin();
    const paths = [values.config, config.videosFile, config.runsFile, config.scenesFile, config.sourceFile, config.approvalFile, config.bootstrapSource];
    const hashes = await Promise.all(paths.map(async file => sha256(await readFile(file, 'utf8'))));
    const source = await readFrozenCourse({ courseId: config.courseId, videos: config.videosFile, runs: config.runsFile, scenes: config.scenesFile, originalInput: config.sourceFile });
    const token = async () => {
      const value = /^oauth_token\s*=\s*"([^"]+)"/m.exec(await readFile(config.wranglerAuthFile, 'utf8'))?.[1];
      if (!value) throw new Error('EVALUATION_AUTH_UNAVAILABLE');
      return value;
    };
    const livePin = () => readLiveSourcePin({ source, accountId: config.accountId, databaseId: config.databaseId, token });
    const initialPin = await livePin();
    const createTransport = () => readOnlySearchTransport({ accountId: config.accountId, indexName: config.indexName, ownerId: source.videos[0].user_id, videoIds: source.videos.map(v => v.id), token, maxCalls: 48 });
    const directory = resolve(config.directory);
    const fixture = await createFrozenEvaluationEnvironment(source, createTransport(), { directory: join(directory, 'database') });
    try {
      await validateReviewedArtifactPackages(fixture, approval.packages);
      // A committed marker binds this persistent DB to one owner decision.
      // Interrupted imports are inspected rather than automatically repeated.
      const db = fixture.env.DB!;
      await db.prepare('CREATE TABLE IF NOT EXISTS evaluation_approval(id INTEGER PRIMARY KEY CHECK(id=1), digest TEXT NOT NULL, ready INTEGER NOT NULL)').run();
      const prior = await db.prepare('SELECT digest,ready FROM evaluation_approval WHERE id=1').first<{ digest: string; ready: number }>();
      const approvalHash = await sha256(approvalRaw);
      if (prior) {
        if (prior.digest !== approvalHash || prior.ready !== 1) throw new Error('EVALUATION_APPROVAL_CHANGED_OR_INCOMPLETE');
      } else {
        await db.prepare('INSERT INTO evaluation_approval VALUES(1,?,0)').bind(approvalHash).run();
        await importOwnerReviewedPackages(fixture, approval);
        await db.prepare('UPDATE evaluation_approval SET ready=1 WHERE id=1').run();
      }
      const approvedSkillHashes = await publicationVersionHashes(fixture.env, fixture.ownerId, config.courseId);
      const baseCommits: Record<string, string> = {};
      const temporary = await mkdtemp(join(tmpdir(), 'videoq-cohort-base-'));
      try { for (const task of evaluationCases) baseCommits[task.id] = await initializeCaseRepository(join(temporary, task.id), task); }
      finally { await rm(temporary, { recursive: true, force: true }); }
      const manifest: CohortManifest = { version: 1, seed: config.seed, repetitions: 2, definitionHash: await sha256(JSON.stringify(evaluationCases)), bootstrapHash: hashes[6], sourceHashes: [...hashes, initialPin, initialImplementation], approvedSkillHashes,
        executorVersion: await codexVersion(), model: config.model, reasoning: 'medium', contextWindow: 32768, timeoutMs: config.timeoutMs, baseCommits };
      const verifyInputs = async () => {
        if (await implementationPin() !== initialImplementation) throw new Error('EVALUATION_IMPLEMENTATION_CHANGED');
        for (const [index, file] of paths.entries()) if (await sha256(await readFile(file, 'utf8')) !== hashes[index]) throw new Error('EVALUATION_FILES_CHANGED');
        await validateReviewedArtifactPackages(fixture, approval.packages);
        await assertPublicationVersions(fixture.env, fixture.ownerId, config.courseId, approvedSkillHashes);
        if (await livePin() !== initialPin) throw new Error('EVALUATION_LIVE_SOURCE_CHANGED');
      };
      const state = await runComparisonCohort({ directory, manifest, cases: evaluationCases, maxTrials, verifyInputs,
        shouldStop: () => access(join(directory, 'STOP')).then(() => true, () => false),
        run: slot => executeComparisonSlot({ slot, task: evaluationCases.find(c => c.id === slot.taskId)!, manifest, directory, env: fixture.env, ownerId: fixture.ownerId, courseId: config.courseId, videoIds: source.videos.map(v => v.id), bootstrapSource: config.bootstrapSource, createTransport }),
      });
      console.info(JSON.stringify({ executed: state.results.length, planned: state.plan.length, executionCompleted: state.completed, humanAssessmentCompleted: false, productionWrites: false }));
    } finally { await fixture.dispose(); }
  }
} catch { console.error('Evaluation stopped. Inspect the private inputs and cohort state; no credentials or course content are logged.'); process.exitCode = 1; }
