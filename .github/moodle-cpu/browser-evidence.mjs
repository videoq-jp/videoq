import {AssertionError} from 'node:assert';

const operations = new Set(['cluster-read', 'backend-maintenance', 'moodle-status', 'moodle-tick',
  'moodle-hide', 'moodle-show', 'moodle-suspend', 'moodle-resume', 'moodle-deny-reports', 'moodle-allow-reports',
  'material-evidence', 'standalone-index-evidence', 'conversation-evidence']);
const phpKinds = new Set(['Error', 'TypeError', 'JsonException', 'RuntimeException', 'coding_exception',
  'dml_read_exception', 'dml_write_exception', 'dml_missing_record_exception', 'dml_multiple_records_exception', 'moodle_exception']);
const phpSources = new Set(['fixture.php', 'export_material.php', 'synchronizer.php', 'client.php',
  'materials_service.php', 'service_auth.php', 'task-manager.php', 'task-adhoc.php', 'task-base.php']);
const phpCodes = new Set(['invalidconfiguration', 'invalidparameter', 'codingerror', 'dmlreadexception',
  'dmlwriteexception', 'invalidrecord', 'invalidtaskclassname']);
const httpServices = new Set(['moodle-oauth', 'moodle-materials']);
const httpCodes = new Set(['ERR_TLS_CERT_ALTNAME_INVALID', 'CERT_HAS_EXPIRED', 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'SELF_SIGNED_CERT_IN_CHAIN', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'ECONNREFUSED', 'ENOTFOUND', 'ETIMEDOUT', 'ABORT_ERR']);

export function commandEvidence(error, operation) {
  const result = {operation: operations.has(operation) ? operation : 'cluster-read'};
  if (Number.isInteger(error?.status) && error.status > 0 && error.status <= 255) result.exitCode = error.status;
  if (['SIGTERM', 'SIGKILL', 'SIGABRT', 'SIGSEGV'].includes(error?.signal)) result.signal = error.signal;
  if (error?.code === 'ETIMEDOUT') result.timedOut = true;
  // Child output is private. Recognize only the fixed metadata producers below,
  // and reconstruct every published field from bounded numbers and enums.
  const raw = [error?.stdout, error?.stderr].map(value =>
    typeof value === 'string' || Buffer.isBuffer(value) ? value.toString() : '').join('\n');
  for (const line of raw.split('\n')) {
    if (result.operation === 'backend-maintenance' && line.startsWith('{')) {
      let log;
      try {log = JSON.parse(line);} catch {continue;}
      if (log?.event === 'scheduled_delivery_recovery' && !result.maintenance) {
        const failed = [];
        for (const task of ['externalTasks', 'ltiMaterials', 'abandonedUploads', 'staleInvitations', 'health']) {
          const message = log[task]?.error;
          if (typeof message !== 'string') continue;
          let reason = 'other';
          if (message === 'LTI materials service unavailable') reason = 'materials-service-unavailable';
          else if (/relation "[^"\n]*" does not exist/.test(message)) reason = 'database-relation-missing';
          else if (/column "[^"\n]*" does not exist/.test(message)) reason = 'database-column-missing';
          else if (/permission denied for (table|schema|sequence) /.test(message)) reason = 'database-permission-denied';
          failed.push({task, reason});
        }
        if (failed.length) result.maintenance = failed;
      }
    }
    const match = line.match(/^VIDEOQ_CPU_(FAILURE|HTTP) (.+)$/);
    if (!match) continue;
    let value;
    try {value = JSON.parse(match[2]);} catch {continue;}
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
    if (match[1] === 'FAILURE' && result.operation.startsWith('moodle-') && !result.php) {
      const php = {};
      if (phpKinds.has(value.kind)) php.kind = value.kind;
      if (phpCodes.has(value.code)) php.code = value.code;
      if (phpSources.has(value.source) && Number.isInteger(value.line) && value.line > 0 && value.line <= 100_000) {
        php.source = value.source; php.line = value.line;
      }
      if (Object.keys(php).length) result.php = php;
    }
    if (match[1] === 'HTTP' && result.operation === 'backend-maintenance' && httpServices.has(value.service)) {
      const http = {service: value.service};
      if (Number.isInteger(value.httpStatus) && value.httpStatus >= 400 && value.httpStatus <= 599) http.httpStatus = value.httpStatus;
      if (value.requestFailed === true) http.requestFailed = true;
      if (httpCodes.has(value.code)) http.code = value.code;
      if (Object.keys(http).length > 1 && !result.http) result.http = http;
    }
  }
  return result;
}

export class AcceptanceCommandError extends Error {
  #evidence;
  constructor(cause, operation) {
    super('Owned acceptance command failed', {cause});
    this.#evidence = commandEvidence(cause, operation);
  }
  get publicEvidence() {return this.#evidence;}
}

// Public CI evidence must never contain messages, selectors, URLs, HTTP bodies,
// credentials or raw stacks from the private browser. Only fixed error classes
// and a numeric location in the reviewed acceptance source are publishable.
export function browserFailure(error, sourceUrl) {
  const kind = error instanceof AssertionError ? 'assertion'
    : error instanceof Error && error.name === 'TimeoutError' ? 'timeout' : 'error';
  const evidence = {kind};
  if (error instanceof AcceptanceCommandError) evidence.command = error.publicEvidence;
  if (!(error instanceof Error) || typeof error.stack !== 'string') return evidence;
  const escaped = sourceUrl.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const frame = new RegExp('(?:\\(|\\s)' + escaped + ':(\\d{1,6}):(\\d{1,6})\\)?$');
  for (const line of error.stack.split('\n')) {
    if (!/^\s+at /.test(line)) continue;
    const match = line.match(frame);
    if (!match) continue;
    const row = Number(match[1]), column = Number(match[2]);
    if (row > 0 && row <= 100_000 && column > 0 && column <= 100_000) {
      evidence.line = row;
      evidence.column = column;
      break;
    }
  }
  return evidence;
}
