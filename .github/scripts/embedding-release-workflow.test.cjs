const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

test('API release refuses apply when embedding provenance preflight fails', () => {
  const workflow = fs.readFileSync(path.join(__dirname, '../workflows/cd.yml'), 'utf8');
  const api = workflow.split('\n  api-deploy:\n')[1].split('\n  db-migrate:\n')[0];
  const commands = api.split('        run: |\n').at(-1).split('\n')
    .filter(line => line.startsWith('          ')).map(line => line.slice(10)).join('\n');
  assert.match(commands, /protect-api-deployment\.cjs deployment\.json\nnode \.github\/scripts\/embedding-release-preflight\.cjs deployment\.json\nnode \.github\/scripts\/terraform-cloudflare-release\.cjs api deployment\.json/);
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'videoq-release-preflight-control-'));
  try {
    const log = path.join(temporary, 'calls');
    fs.writeFileSync(path.join(temporary, 'node'), '#!/bin/sh\nprintf "%s\\n" "$*" >> "$GATE_CALL_LOG"\ncase "$1" in *embedding-release-preflight.cjs) exit 1;; esac\n', { mode: 0o755 });
    const result = spawnSync('bash', ['-e', '-c', commands], { encoding: 'utf8', env: {
      ...process.env, PATH: `${temporary}:${process.env.PATH}`, GATE_CALL_LOG: log,
      CLOUDFLARE_API_TOKEN: 'synthetic', CLOUDFLARE_ACCOUNT_ID: 'synthetic',
    } });
    assert.equal(result.status, 1);
    const calls = fs.readFileSync(log, 'utf8');
    assert.match(calls, /protect-api-deployment/);
    assert.match(calls, /embedding-release-preflight/);
    assert.doesNotMatch(calls, /terraform-cloudflare-release/);
  } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
});
