const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { nodeImageVersion } = require('./container-runtime-pins.cjs');
const image = version => `FROM node:${version}-alpine@sha256:${'a'.repeat(64)} AS build\nFROM nginx:alpine AS runtime\n`;
test('Dependabot image versions are checked independently of local and CI Node versions', () => {
  for (const version of ['26.14.0', '28.0.0']) assert.equal(nodeImageVersion(image(version)), version);
  const workflow = readFileSync(join(__dirname, '../workflows/container-validation.yml'), 'utf8');
  assert.ok(workflow.includes('node .github/scripts/container-runtime-pins.cjs "$DOCKERFILE"'));
  assert.doesNotMatch(workflow, /cat \.node-version/);
  assert.match(workflow, /process\.versions\.node/);
});
test('image checks reject mutable, ambiguous and nonstable Node references', () => {
  for (const text of ['FROM node:26-alpine', 'FROM node:26.14.0-alpine', image('26.14.0-rc.1'), image('26.14.0') + image('28.0.0')]) {
    assert.throws(() => nodeImageVersion(text));
  }
});
