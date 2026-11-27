import { spawn } from 'node:child_process';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { z } from 'zod';
import type { EvaluationCase } from './cases';

// Only this trusted driver writes to the host stdout. Test-process console
// output arrives as test:stdout/test:stderr events, never as scoring events.
const driver = `import {run} from 'node:test';
const [grader,workspace,grading]=process.argv.slice(2);
const stream=run({files:[grader],isolation:'process',concurrency:1,timeout:8000,execArgv:['--permission','--allow-fs-read='+workspace,'--allow-fs-read='+grading]});
let contractPasses=0,failures=0,summary=null,stdout='',stderr='';
for await(const event of stream){
 if(event.type==='test:pass'&&event.data.file===grader&&event.data.name.startsWith('videoq-contract:'))contractPasses++;
 if(event.type==='test:fail')failures++;
 if(event.type==='test:summary'&&event.data.file===undefined)summary=event.data;
 if(event.type==='test:stdout')stdout=(stdout+event.data.message).slice(-20000);
 if(event.type==='test:stderr')stderr=(stderr+event.data.message).slice(-20000);
}
console.log(JSON.stringify({functional:contractPasses>0&&failures===0&&summary?.success===true&&summary.counts.failed===0&&summary.counts.cancelled===0,contractPasses,failures,stdout,stderr}));
`;
const resultSchema = z.object({ functional: z.boolean(), contractPasses: z.number().int().nonnegative(), failures: z.number().int().nonnegative(), stdout: z.string(), stderr: z.string() });

/** Independent post-check of frozen output; never reruns a model or alters a trial. */
export async function gradeCaseStrict(task: EvaluationCase, workspace: string) {
  if (task.kind !== 'code' || !task.assertions) return { functional: null, humanReviewRequired: true, timedOut: false };
  for (const path of task.immutableFiles ?? []) if (await readFile(join(workspace, path), 'utf8').catch(() => null) !== task.files[path]) return { functional: false, humanReviewRequired: true, timedOut: false };
  const directory = await mkdtemp(join(tmpdir(), 'videoq-strict-contract-'));
  try {
    const canonical = await realpath(directory), target = await realpath(workspace), grader = join(canonical, 'contract.test.mjs'), runner = join(canonical, 'driver.mjs');
    await writeFile(runner, driver, { mode: 0o600 });
    await writeFile(grader, `import assert from 'node:assert/strict';\nimport {test as nodeTest} from 'node:test';\nimport {pathToFileURL} from 'node:url';\nconst test=(name,fn)=>nodeTest('videoq-contract:'+name,fn);\nconst subject=await import(pathToFileURL(process.env.VIDEOQ_EVALUATION_WORKSPACE+'/src/main.mjs').href);\n${task.assertions}\n`, { mode: 0o600 });
    const env = { PATH: process.env.PATH, TZ: 'UTC', VIDEOQ_EVALUATION_WORKSPACE: target } as unknown as NodeJS.ProcessEnv;
    const result = await new Promise<{ code: number | null; timedOut: boolean; output: string }>((resolve, reject) => {
      const child = spawn(process.execPath, [runner, grader, target, canonical], { cwd: target, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
      let output = '', timedOut = false;
      const timer = setTimeout(() => { timedOut = true; if (child.pid) try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); } }, 10000);
      child.stdout.on('data', (data: Buffer) => { output = (output + data.toString()).slice(-100000); });
      child.stderr.resume();
      child.once('error', error => { clearTimeout(timer); reject(error); });
      child.once('close', code => { clearTimeout(timer); resolve({ code, timedOut, output }); });
    });
    const parsed = resultSchema.safeParse(((): unknown => { try { return JSON.parse(result.output); } catch { return null; } })());
    return { ...(parsed.success ? parsed.data : {}), functional: result.code === 0 && !result.timedOut && parsed.success && parsed.data.functional,
      humanReviewRequired: true, timedOut: result.timedOut };
  } finally { await rm(directory, { recursive: true, force: true }); }
}
