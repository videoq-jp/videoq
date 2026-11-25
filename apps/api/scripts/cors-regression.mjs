/** Automated isolated Garage + real Chromium acceptance; never contacts production. */
import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import { readFile, mkdir, writeFile, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { chromium } from 'playwright';

const output = resolve(process.argv[2] ?? 'artifacts/cors-browser.json');
await mkdir(resolve(output, '..'), { recursive: true });
await rm(output, { force: true });
await rm(`${output}.failure.json`, { force: true });
const name = `videoq-cors-${randomUUID()}`;
const image = 'dxflrs/garage:v2.5.0@sha256:677e5b758e4425a325b811c425c026bf35a4bf42f7ddbaa773de3f4fd779a5a5';
let fixture, browser, stage = 'garage-start';
const docker = (...args) => execFileSync('docker', args, { encoding: 'utf8', timeout: 180000, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
try {
  docker('run', '--detach', '--rm', '--name', name, '--publish', '127.0.0.1::3900',
    '--mount', `type=bind,source=${resolve('infra/garage/garage.toml')},target=/etc/garage.toml,readonly`,
    '--env', 'GARAGE_DEFAULT_ACCESS_KEY=GK00000000000000000000000000000000',
    '--env', `GARAGE_DEFAULT_SECRET_KEY=${'0'.repeat(64)}`,
    '--env', `GARAGE_RPC_SECRET=${'1'.repeat(64)}`, '--env', 'GARAGE_DEFAULT_BUCKET=videoq-cors-acceptance',
    image, '/garage', 'server', '--single-node', '--default-bucket');
  const port = docker('port', name, '3900/tcp').split(':').at(-1);
  stage = 'garage-ready';
  for (let attempt = 0; ; attempt++) {
    try { docker('exec', name, '/garage', 'bucket', 'info', 'videoq-cors-acceptance'); break; }
    catch { if (attempt === 59) throw new Error('Isolated Garage readiness timed out'); }
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  stage = 'fixture-ready';
  fixture = spawn(process.execPath, ['--import', 'tsx', 'apps/api/scripts/cors-acceptance.mjs', output], {
    env: { ...process.env, CORS_ACCEPTANCE_ISOLATED: '1', CORS_ACCEPTANCE_STORAGE_URL: `http://127.0.0.1:${port}/` },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  // Fixture errors and browser console messages can contain signed URLs: do not publish them.
  fixture.stderr.resume();
  const urls = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('CORS fixture startup timed out')), 60000);
    fixture.once('exit', () => { clearTimeout(timer); reject(new Error('CORS fixture exited before readiness')); });
    createInterface({ input: fixture.stdout }).on('line', line => {
      try { const value = JSON.parse(line); if (value.allowed && value.denied) { clearTimeout(timer); resolve(value); } } catch {}
    });
  });
  stage = 'chromium-start';
  browser = await chromium.launch();
  // Same browser context preserves cookie behavior; both origins remain separate ports.
  const context = await browser.newContext();
  for (const role of ['allowed', 'denied']) {
    stage = `browser-${role}`;
    const page = await context.newPage();
    await page.goto(urls[role]);
    await page.getByRole('button', { name: 'Run checks' }).click();
    await page.waitForFunction(() => document.body.dataset.done === 'true', undefined, { timeout: 120000 });
    await page.close();
  }
  stage = 'assert-report';
  const report = JSON.parse(await readFile(output, 'utf8'));
  if (!report.complete || !report.allPassed || report.results.allowed.rows.length !== 10 || report.results.denied.rows.length !== 5 ||
      !Object.values(report.serverChecks).every(value => value === true)) throw new Error('CORS regression failed; inspect sanitized evidence');
  console.log('CORS regression passed: 10 allowed + 5 denied; server no-body and multipart integrity verified');
} catch {
  // Preserve any partial sanitized fixture report and a separate failure marker.
  await writeFile(`${output}.failure.json`, JSON.stringify({ passed: false, stage, error: 'CORS browser regression did not complete successfully' }) + '\n');
  throw new Error(`CORS browser regression failed at ${stage} (sanitized evidence retained)`);
} finally {
  await browser?.close();
  if (fixture && fixture.exitCode === null) {
    const exited = once(fixture, 'exit'); fixture.kill('SIGTERM');
    const timer = setTimeout(() => fixture.kill('SIGKILL'), 15000);
    await exited; clearTimeout(timer);
  }
  try { docker('rm', '--force', name); } catch {}
}
