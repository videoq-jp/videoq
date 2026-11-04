// Run the same maintenance entrypoints as the Helm CronJobs. No overlapping jobs.
import { spawn } from 'node:child_process';

let stopping = false;
let active;
let retentionDay;
let timer;

async function run(command) {
  const exitCode = await new Promise((resolve, reject) => {
    active = spawn(process.execPath, ['dist/node.mjs', command], { stdio: 'inherit' });
    active.once('error', reject);
    active.once('exit', (code) => resolve(code));
  });
  active = undefined;
  if (exitCode !== 0) throw new Error(`${command} failed (${exitCode})`);
}

async function tick() {
  try {
    await run('maintenance');
    const now = new Date();
    const day = now.toISOString().slice(0, 10);
    if (!stopping && day !== retentionDay) {
      await run('retention');
      retentionDay = day;
    }
  } catch (error) {
    console.error(error.message);
    // Restart under Compose, making failures visible in container restart counts.
    process.exitCode = 1;
    stopping = true;
  }
  if (!stopping) timer = setTimeout(tick, 60_000);
}

for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    stopping = true;
    clearTimeout(timer);
    active?.kill(signal);
  });
}
await tick();
