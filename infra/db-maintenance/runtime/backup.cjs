const {execFileSync} = require('node:child_process');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

/** The credential wrapper removes AWS credentials before the DB child starts.
 * Upload only from this parent, after the child has returned a verified handoff.
 * Dependencies are injectable for tests, never taken from invocation input. */
async function runBackup({env=process.env,execute=execFileSync,retain}={}) {
  const archive = await import('../../../.github/scripts/backup-archive.mjs');
  const context = archive.backupArchiveContext(env);
  const exportD1 = archive.backupD1ExportRequested(env);
  let directory, report;
  try {
    if (context) {
      directory = await fs.mkdtemp(path.join(os.tmpdir(),'videoq-backup-handoff-'));
      await fs.chmod(directory,0o700);
    }
    execute('python3',['.github/scripts/with-neon-credentials.py','backup','node','.github/scripts/backup-restore.mjs'],
      {stdio:['ignore','pipe','pipe'],maxBuffer:8*1024*1024,env:{...env,VIDEOQ_BACKUP_HANDOFF:directory??'',OPERATION:'audit',
        GITHUB_REF:'refs/heads/main',GITHUB_REPOSITORY:'videoq-jp/videoq'}});
    report = JSON.parse(await fs.readFile('operations-report.json','utf8'));
    if (report.status !== 'ok' || report.backup_retention !== (context ? 'staged' : 'disabled')) {
      const stages = new Set(['database-connect','restore-image-version','read-only-snapshot','logical-backup','isolated-restore','restore-server-readiness','restore-server-oom','restore-server-exited','restore-vector-extension','restore-archive-list','restore-list-file','restore-archive-apply','restore-loopback-port','restore-client-connect','row-count-and-constraint-verification','verified-backup-handoff']);
      for (const [category] of archive.RESTORE_FAILURE_CATEGORIES) stages.add('restore-archive-apply-' + category);
      const match = Array.isArray(report.details) && report.details.length === 1 && typeof report.details[0] === 'string'
        ? /^- 失敗した段階: `([a-z-]+)`。DB接続情報・レコード・バックアップは出力していません。$/.exec(report.details[0]) : null;
      const stage = match && stages.has(match[1]) ? match[1].replaceAll('-', '_').toUpperCase() : null;
      const state = typeof report.failure_sqlstate === 'string' && Object.hasOwn(archive.RESTORE_SQLSTATE_CATEGORIES,report.failure_sqlstate) ? '_SQLSTATE_' + report.failure_sqlstate : '';
      const operation = archive.RESTORE_OPERATIONS.includes(report.failure_operation) ? '_OPERATION_' + report.failure_operation : '';
      throw new Error(stage ? 'BACKUP_VERIFICATION_FAILED_' + stage + state + operation : 'PRODUCTION_VERIFICATION_FAILED');
    }
    if ((report.d1_archive??'not_requested') !== (exportD1?'staged':'not_requested')) throw new Error('D1_BACKUP_EXPORT_NOT_CONFIRMED');
    if (context) {
      const retained=retain?await retain(directory,context,{requireD1Export:exportD1}):
        await archive.retainStagedBackup(directory,context,undefined,{requireD1Export:exportD1});
      if (!retained) throw new Error('BACKUP_RETENTION_NOT_CONFIRMED');
      report.backup_retention = 'retained';
      report.d1_archive = exportD1?'retained':'not_requested';
      report.details.push('- 親AWSジョブが専用S3への保存を行い、version・checksum・size・暗号化を照合しました。');
      await fs.writeFile('operations-report.json',JSON.stringify(report));
    }
  } catch (error) {
    if (report) {
      if (typeof report.failure_sqlstate !== 'string' || !Object.hasOwn(archive.RESTORE_SQLSTATE_CATEGORIES,report.failure_sqlstate)) delete report.failure_sqlstate;
      if (!archive.RESTORE_OPERATIONS.includes(report.failure_operation)) delete report.failure_operation;
      report.status = 'error';
      if (context) report.backup_retention = 'failed';
      if (exportD1) report.d1_archive = 'failed';
      report.details = ['- AWSバックアップ検証または永続保存に失敗しました。完了済みの保全コピーとは扱わないでください。'];
      await fs.writeFile('operations-report.json',JSON.stringify(report));
    }
    throw error;
  } finally {
    if (directory) await fs.rm(directory,{recursive:true,force:true});
  }
}
module.exports = {runBackup};
