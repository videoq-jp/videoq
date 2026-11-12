const {writeFileSync} = require('node:fs');

function queueSecrets(env) {
  const secrets = {};
  let account;
  for (const group of ['search', 'account']) {
    const key = `SQS_${group.toUpperCase()}_QUEUE_URL`;
    const value = env[`WORKER_${group.toUpperCase()}_QUEUE_URL`]?.trim();
    const match = /^https:\/\/sqs\.ap-northeast-1\.amazonaws\.com\/(\d{12})\/videoq-worker-(search|account)-prod$/.exec(value || '');
    if (!match || match[2] !== group || (account && account !== match[1])) {
      throw new Error('Supply both production SQS queue URLs from the same AWS account');
    }
    account = match[1];
    secrets[key] = value;
  }
  return secrets;
}

if (require.main === module) {
  writeFileSync(process.argv[2], JSON.stringify(queueSecrets(process.env)), {mode: 0o600});
}
module.exports = {queueSecrets};
