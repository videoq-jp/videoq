const {test} = require('node:test');
const assert = require('node:assert/strict');
const {assertProductionSmoke} = require('./production-smoke-result.cjs');
test('AWS receives only an allowlisted failed smoke stage', () => {
  assert.doesNotThrow(() => assertProductionSmoke({status:'ok'}));
  assert.throws(() => assertProductionSmoke({status:'error', details:['- 失敗した段階: `database-and-cleanup`。認証情報や利用者のデータはログに出力していません。']}), {message:'PRODUCTION_VERIFICATION_FAILED_STAGE_DATABASE_AND_CLEANUP'});
});
test('untrusted report text cannot enter the AWS error', () => {
  for (const report of [undefined, {status:'error',summary:'PRIVATE',details:['PRIVATE']}, {status:'error',details:['- 失敗した段階: `private-secret`。認証情報や利用者のデータはログに出力していません。']}, {status:'error',details:[{secret:'PRIVATE'}]}]) {
    assert.throws(() => assertProductionSmoke(report), {message:'PRODUCTION_VERIFICATION_FAILED'});
  }
});
