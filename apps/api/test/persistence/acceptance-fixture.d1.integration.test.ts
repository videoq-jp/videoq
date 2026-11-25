import { it, expect } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createD1Fixture } from './d1-fixture';
import { createD1Auth } from '../../src/persistence/d1/auth';
import type { Bindings } from '../../src/types/bindings';

it('fresh private seed authenticates a native admin and labels synthetic policy facts', async () => {
  const directory = mkdtempSync(tmpdir() + '/videoq-fixture-test-');
  const fixture = await createD1Fixture();
  try {
    execFileSync(process.execPath, [resolve('scripts/acceptance/prepare-fixture.mjs')], {
      env: { ...process.env, ACCEPTANCE_PRIVATE_DIR: directory }, stdio: 'pipe',
    });
    const state = JSON.parse(readFileSync(directory + '/private.json', 'utf8'));
    expect(statSync(directory + '/private.json').mode & 0o777).toBe(0o600);
    expect(statSync(directory + '/seed.sql').mode & 0o777).toBe(0o600);
    // This fixed synthetic template has no semicolons within SQL literals.
    const statements = readFileSync(directory + '/seed.sql', 'utf8').replace(/^--.*$/gm, '').split(';').map(value => value.trim()).filter(Boolean);
    await fixture.database.batch(statements.map(sql => fixture.database.prepare(sql)));
    const origin = 'https://acceptance.example.test';
    const env = { ENVIRONMENT: 'production', DEPLOYMENT_EDITION: 'cloud', PERSISTENCE_BACKEND: 'd1', DB: fixture.database,
      BETTER_AUTH_URL: origin, FRONTEND_URL: origin, CORS_ALLOW_ORIGIN: origin, BETTER_AUTH_SECRET: state.authSecret } as Bindings;
    const auth = createD1Auth(env, fixture.database, 'browser');
    const response = await auth.handler(new Request(origin + '/api/auth/sign-in/email', { method: 'POST',
      headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify({ email: 'acceptance@example.test', password: state.password }) }));
    expect(response.status).toBe(200);
    const cookie = response.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');
    const session = await auth.api.getSession({ headers: new Headers({ cookie }), query: { disableCookieCache: true, disableRefresh: true } });
    expect(session?.user.id).toBe('owner');
    expect((await fixture.database.prepare("SELECT role FROM users WHERE id='owner'").first())?.role).toBe('admin');
    expect((await fixture.database.prepare('SELECT count(*) AS count FROM videos').first())?.count).toBe(2);
    expect((await fixture.database.prepare("SELECT count(*) AS count FROM policy_cleanup WHERE id='isolated-cleanup-probe'").first())?.count).toBe(1);
    expect(() => execFileSync(process.execPath, [resolve('scripts/acceptance/prepare-fixture.mjs')], {
      env: { ...process.env, ACCEPTANCE_PRIVATE_DIR: directory }, stdio: 'pipe',
    })).toThrow();
  } finally { await fixture.dispose(); rmSync(directory, { recursive: true, force: true }); }
}, 30000);
