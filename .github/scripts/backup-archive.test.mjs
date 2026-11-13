import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, writeFile, readFile, rm, chmod, symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {ARCHIVE_BUCKET, backupArchiveContext, retainVerifiedBackup} from './backup-archive.mjs';
const env = {VIDEOQ_RETAIN_BACKUP: 'true', MAINTENANCE_STAGE: 'backup', MAINTENANCE_RUN_ID: 'a'.repeat(32),
  CODEBUILD_BUILD_ARN: 'arn:aws:codebuild:ap-northeast-1:257240362763:build/videoq-db-backup-prod:12345678-1234-1234-1234-123456789abc', CODEBUILD_SOURCE_VERSION: 'immutable-source-version'};
const context = backupArchiveContext(env);

test('retention is explicit and limited to the fixed backup build/run context', () => {
  assert.equal(backupArchiveContext({}), null);
  assert.equal(backupArchiveContext({VIDEOQ_RETAIN_BACKUP: 'false'}), null);
  for (const mutation of [{VIDEOQ_RETAIN_BACKUP:'1'}, {MAINTENANCE_STAGE:'smoke'}, {MAINTENANCE_RUN_ID:'../other'},
    {CODEBUILD_BUILD_ARN:env.CODEBUILD_BUILD_ARN.replace('backup-prod','migration-prod')}, {CODEBUILD_SOURCE_VERSION:''}]) {
    assert.throws(() => backupArchiveContext({...env,...mutation}), /INVALID_BACKUP_ARCHIVE_CONTEXT/);
  }
});

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'videoq-archive-unit-'));
  t.after(() => rm(directory, {recursive:true,force:true}));
  await writeFile(join(directory,'database.dump'), Buffer.from([0,255,34,92,128]), {mode:0o600});
  const options = {directory, context, inventory:{'"public"."synthetic"':'1'}, schemas:['public','drizzle','videoq_security','chat_memory'], image:'synthetic-pinned-image'};
  const calls = [], objects = new Map();
  const run = async (command,args,settings) => {
    calls.push(args);
    assert.equal(command,'aws');
    const value = flag => args[args.indexOf(flag)+1];
    assert.equal(value('--bucket'),ARCHIVE_BUCKET);
    assert.equal(value('--expected-bucket-owner'),'257240362763');
    assert.equal(value('--region'),'ap-northeast-1');
    assert.equal(settings.env.AWS_IGNORE_CONFIGURED_ENDPOINT_URLS,'true');
    const key = value('--key');
    assert.ok(key.startsWith('verified/'+env.MAINTENANCE_RUN_ID+'/'));
    if (args[1] === 'put-object') {
      assert.equal(value('--if-none-match'),'*');
      assert.equal(value('--server-side-encryption'),'AES256');
      assert.equal(objects.has(key),false);
      const body = await readFile(value('--body'));
      const digest = createHash('sha256').update(body).digest('base64');
      assert.equal(value('--checksum-sha256'),digest);
      const object = {VersionId:'version-'+objects.size, ChecksumSHA256:digest, ServerSideEncryption:'AES256', ContentLength:body.length};
      objects.set(key,object);
      return {stdout:JSON.stringify(object)};
    }
    assert.equal(args[1],'head-object');
    const object = objects.get(key);
    assert.equal(value('--version-id'),object.VersionId);
    assert.equal(value('--checksum-mode'),'ENABLED');
    return {stdout:JSON.stringify(object)};
  };
  return {options,run,calls,objects};
}

test('retains verified dump then private completion manifest with versioned checksum readback', async t => {
  const {options,run,calls} = await fixture(t);
  assert.equal(await retainVerifiedBackup(options,run),true);
  assert.deepEqual(calls.map(args=>args[1]),['put-object','head-object','put-object','head-object']);
  const manifest = JSON.parse(await readFile(join(options.directory,'verified-backup.json'),'utf8'));
  assert.equal(manifest.status,'restored-and-retained');
  assert.equal(manifest.dump.version_id,'version-0');
  assert.equal(manifest.dump.bytes,5);
  assert.deepEqual(manifest.schemas,options.schemas);
  assert.deepEqual(manifest.inventory,options.inventory);
  assert.equal(manifest.source.operator_source_version,env.CODEBUILD_SOURCE_VERSION);
});

test('disabled retention performs no storage request', async t => {
  const {options} = await fixture(t);
  assert.equal(await retainVerifiedBackup({...options,context:null},()=>assert.fail('storage request')),false);
});

test('mismatched stored bytes/checksum/encryption/version cannot publish a completion manifest', async t => {
  for (const mutation of [{ContentLength:999}, {ChecksumSHA256:'wrong'}, {ServerSideEncryption:'none'}, {VersionId:'other'}]) {
    const {options,run,calls} = await fixture(t);
    await assert.rejects(retainVerifiedBackup(options,async (...args) => {
      const response = await run(...args);
      return args[1][1] === 'head-object' ? {stdout:JSON.stringify({...JSON.parse(response.stdout),...mutation})} : response;
    }),/BACKUP_READBACK_NOT_VERIFIED/);
    assert.equal(calls.length,2);
    await assert.rejects(readFile(join(options.directory,'verified-backup.json')), {code:'ENOENT'});
  }
});

test('unversioned or corrupted upload acknowledgements fail before readback or completion', async t => {
  for (const mutation of [{VersionId:'null'}, {ChecksumSHA256:'wrong'}, {ServerSideEncryption:'none'}]) {
    const {options,run,calls} = await fixture(t);
    await assert.rejects(retainVerifiedBackup(options,async (...args) => {
      const response = await run(...args);
      return {stdout:JSON.stringify({...JSON.parse(response.stdout),...mutation})};
    }),/BACKUP_UPLOAD_NOT_VERIFIED/);
    assert.equal(calls.length,1);
  }
});

test('upload failures are not reported as retention success', async t => {
  const {options} = await fixture(t);
  await assert.rejects(retainVerifiedBackup(options,async()=>{throw new Error('unavailable');}),/unavailable/);
  await assert.rejects(readFile(join(options.directory,'verified-backup.json')), {code:'ENOENT'});
});

test('refuses world-readable dump files and symlink substitution', async t => {
  const {options} = await fixture(t);
  await chmod(join(options.directory,'database.dump'),0o644);
  await assert.rejects(retainVerifiedBackup(options,()=>assert.fail('storage request')),/INVALID_PRIVATE_BACKUP_FILE/);
  await rm(join(options.directory,'database.dump'));
  await writeFile(join(options.directory,'other'),'synthetic',{mode:0o600});
  await symlink(join(options.directory,'other'),join(options.directory,'database.dump'));
  await assert.rejects(retainVerifiedBackup(options,()=>assert.fail('storage request')),/INVALID_PRIVATE_BACKUP_FILE/);
});

test('DB child stages a private verified dump; AWS parent uploads the exact staged copy', async t => {
  const {stageVerifiedBackup,retainStagedBackup,BACKUP_SCHEMAS} = await import('./backup-archive.mjs');
  const {options,run,calls} = await fixture(t);
  const destination = await mkdtemp(join(tmpdir(),'videoq-backup-handoff-'));
  t.after(()=>rm(destination,{recursive:true,force:true}));
  const image = (await readFile(new URL('../operations-tools/Dockerfile',import.meta.url),'utf8')).trim().replace(/^FROM /,'');
  assert.equal(await stageVerifiedBackup({...options,destination,image,schemas:BACKUP_SCHEMAS}),true);
  assert.equal(calls.length,0,'The DB child must not contact AWS.');
  const marker=JSON.parse(await readFile(join(destination,'verified-backup-input.json'),'utf8'));
  assert.equal(marker.status,'restore-verified');
  assert.deepEqual(marker.context,context);
  await rm(join(options.directory,'database.dump'));
  assert.equal(await retainStagedBackup(destination,context,run),true);
  assert.equal(calls.length,4);
  const manifest=JSON.parse(await readFile(join(destination,'verified-backup.json'),'utf8'));
  assert.equal(manifest.status,'restored-and-retained');
});

test('stale handoff context or modified dump cannot authorize any AWS request', async t => {
  const {stageVerifiedBackup,retainStagedBackup,BACKUP_SCHEMAS} = await import('./backup-archive.mjs');
  const {options} = await fixture(t);
  const destination=await mkdtemp(join(tmpdir(),'videoq-backup-handoff-'));
  t.after(()=>rm(destination,{recursive:true,force:true}));
  const image=(await readFile(new URL('../operations-tools/Dockerfile',import.meta.url),'utf8')).trim().replace(/^FROM /,'');
  await stageVerifiedBackup({...options,destination,image,schemas:BACKUP_SCHEMAS});
  const noAWS=()=>assert.fail('Unverified handoff must not contact AWS.');
  await assert.rejects(retainStagedBackup(destination,{...context,runId:'b'.repeat(32)},noAWS),/INVALID_BACKUP_HANDOFF_MARKER/);
  await writeFile(join(destination,'database.dump'),Buffer.from([9,255,34,92,128]));
  await assert.rejects(retainStagedBackup(destination,context,noAWS),/BACKUP_HANDOFF_INTEGRITY_FAILED/);
});

test('requires an empty private parent-owned directory and complete private marker', async t => {
  const {stageVerifiedBackup,retainStagedBackup,BACKUP_SCHEMAS} = await import('./backup-archive.mjs');
  const {options} = await fixture(t);
  const destination=await mkdtemp(join(tmpdir(),'videoq-backup-handoff-'));
  t.after(()=>rm(destination,{recursive:true,force:true}));
  const image=(await readFile(new URL('../operations-tools/Dockerfile',import.meta.url),'utf8')).trim().replace(/^FROM /,'');
  await chmod(destination,0o755);
  await assert.rejects(stageVerifiedBackup({...options,destination,image,schemas:BACKUP_SCHEMAS}),/INVALID_BACKUP_HANDOFF/);
  await chmod(destination,0o700);
  await assert.rejects(retainStagedBackup(destination,context,()=>assert.fail('AWS')),/INCOMPLETE_BACKUP_HANDOFF/);
  await stageVerifiedBackup({...options,destination,image,schemas:BACKUP_SCHEMAS});
  await assert.rejects(stageVerifiedBackup({...options,destination,image,schemas:BACKUP_SCHEMAS}),/BACKUP_HANDOFF_NOT_EMPTY/);
  await chmod(join(destination,'verified-backup-input.json'),0o644);
  await assert.rejects(retainStagedBackup(destination,context,()=>assert.fail('AWS')),/INVALID_BACKUP_HANDOFF_MARKER/);
});
