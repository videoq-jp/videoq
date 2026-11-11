// Install only the tools used by this immutable job/stage. No shared writable
// dependency cache: npm still verifies the lockfile and registry signatures.
const {execFileSync} = require('node:child_process');
const {assertBuildArn} = require('./job.cjs');

function installTools(run = (command, args) => execFileSync(command, args, {stdio: 'inherit'})) {
  run('npm', ['ci', '--ignore-scripts', '--prefix', '.github/operations-tools']);
  run('npm', ['audit', 'signatures', '--prefix', '.github/operations-tools']);
}

function setup(env = process.env, run = (command, args) => execFileSync(command, args, {stdio: 'inherit'})) {
  assertBuildArn(env.CODEBUILD_BUILD_ARN);
  const purpose = env.CODEBUILD_BUILD_ARN.match(/build\/videoq-db-([a-z]+)-prod:/)[1];
  const stage = env.MAINTENANCE_STAGE;
  const stages = {
    rotation: ['prepare', 'retire', 'complete', 'retire-rollback', 'complete-rollback'],
    migration: ['migration'], backup: ['backup'], smoke: ['smoke'], audit: ['audit'],
  };
  if (!stages[purpose]?.includes(stage)) throw new Error('INVALID_SETUP_STAGE');
  // Migrations install their own canonical-main tools in job.cjs. Rotation age
  // audits and completion records only use built-in modules and the AWS CLI.
  // prepare lazily installs tools in job.cjs only when credentials are due.
  if (purpose === 'migration' || purpose === 'rotation' &&
      ['prepare', 'complete', 'complete-rollback'].includes(stage)) return;
  installTools(run);
  if (purpose === 'smoke') {
    // production-smoke uses chromium.launch() without a channel in AWS.
    // standard:7.0 already supplies Chromium's shared libraries. Avoid upgrading
    // unrelated OS packages and installing fonts for unused languages per run.
    run('.github/operations-tools/node_modules/.bin/playwright', ['install', '--only-shell', 'chromium']);
    run('sh', ['-eu', '-c', 'if [ -z "$(fc-list :lang=ja)" ]; then apt-get update && apt-get install -y --no-install-recommends fonts-ipafont-gothic; fi; test -n "$(fc-list :lang=ja)"']);
  }
}

module.exports = {setup, installTools};
if (require.main === module) setup();
