const {test} = require('node:test');
const assert = require('node:assert/strict');
const {queueSecrets} = require('./worker-queue-secrets.cjs');
const url = group => `https://sqs.ap-northeast-1.amazonaws.com/123456789012/videoq-worker-${group}-prod`;
const env = {WORKER_SEARCH_QUEUE_URL: url('search'), WORKER_ACCOUNT_QUEUE_URL: url('account')};
test('routing sync updates only the two group overrides', () => {
  assert.deepEqual(queueSecrets(env), {SQS_SEARCH_QUEUE_URL: url('search'), SQS_ACCOUNT_QUEUE_URL: url('account')});
});
test('routing sync rejects incomplete, cross-account and unexpected endpoints', () => {
  for (const value of ['', url('search'), url('account').replace('123456789012', '111111111111'), url('account').replace('amazonaws.com', 'example.com'), `${url('account')}?redirect=1`]) {
    assert.throws(() => queueSecrets({...env, WORKER_ACCOUNT_QUEUE_URL: value}));
  }
});
