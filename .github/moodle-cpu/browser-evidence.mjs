import {AssertionError} from 'node:assert';
import {fileURLToPath} from 'node:url';

const operations = new Set(['cluster-read', 'backend-maintenance', 'moodle-status', 'moodle-tick',
  'moodle-hide', 'moodle-show', 'moodle-suspend', 'moodle-resume', 'moodle-deny-reports', 'moodle-allow-reports',
  'material-evidence', 'standalone-index-evidence', 'conversation-evidence',
  'privacy-memory-evidence', 'privacy-archive-evidence', 'moodle-privacy-setup', 'moodle-privacy-status',
  'moodle-privacy-task', 'moodle-privacy-export-evidence', 'moodle-privacy-reset']);
const phpKinds = new Set(['Error', 'TypeError', 'JsonException', 'RuntimeException', 'coding_exception',
  'dml_read_exception', 'dml_write_exception', 'dml_missing_record_exception', 'dml_multiple_records_exception', 'moodle_exception']);
const phpSources = new Set(['fixture.php', 'privacy-fixture.php', 'export_material.php', 'synchronizer.php', 'client.php',
  'materials_service.php', 'service_auth.php', 'task-manager.php', 'task-adhoc.php', 'task-base.php']);
const phpCodes = new Set(['invalidconfiguration', 'invalidparameter', 'codingerror', 'dmlreadexception',
  'dmlwriteexception', 'invalidrecord', 'invalidtaskclassname']);
const httpServices = new Set(['moodle-oauth', 'moodle-materials']);
const httpCodes = new Set(['ERR_TLS_CERT_ALTNAME_INVALID', 'CERT_HAS_EXPIRED', 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'SELF_SIGNED_CERT_IN_CHAIN', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'ECONNREFUSED', 'ECONNRESET', 'EHOSTUNREACH', 'ENETUNREACH', 'EAI_AGAIN', 'ENOTFOUND', 'ETIMEDOUT', 'ABORT_ERR',
  'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_SOCKET']);

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
      if (['timeout', 'error'].includes(value.requestKind)) http.requestKind = value.requestKind;
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

// Playwright action logs can include private selectors and markup. Recognize
// only its fixed actionability phrases, then retain only booleans on re-read.
export function clickActionabilityEvidence(value) {
  const signals = {pointerIntercepted: 'intercepts pointer events', outsideViewport: 'outside of the viewport',
    unstable: 'element is not stable', invisible: 'element is not visible', disabled: 'element is not enabled',
    detached: 'element was detached', frameDetached: 'frame was detached', scrolled: 'done scrolling',
    retrying: 'retrying click action', waitingForLocator: 'waiting for locator', resolvedElement: 'locator resolved to',
    attemptingClick: 'attempting click action', checkingActionability: 'waiting for element to be visible, enabled and stable',
    scrollingStarted: 'scrolling into view if needed', waitingForNavigation: 'navigation to finish',
    locatorHandler: 'intercepting action to run the handler', hiddenFrame: 'inside a hidden frame'};
  let source = value;
  if (value instanceof Error && typeof value.message === 'string') {
    const log = Array.isArray(value.log) ? value.log.filter(line => typeof line === 'string').slice(0, 10000) : [];
    const raw = [value.message, ...log].join('\n');
    source = Object.fromEntries(Object.entries(signals).map(([key, phrase]) => [key, raw.includes(phrase)]));
    if (Array.isArray(value.log)) source.logLines = log.length;
  }
  const result = {};
  if (!source || typeof source !== 'object' || Array.isArray(source)) return result;
  for (const key of Object.keys(signals)) if (typeof source[key] === 'boolean') result[key] = source[key];
  if (Number.isInteger(source.logLines) && source.logLines >= 0 && source.logLines <= 10000) result.logLines = source.logLines;
  return result;
}

// A failed native tool must be diagnosable without publishing its HTML, labels,
// credentials or API bodies. Rebuild every field from fixed names and bounds.
export function tagUiEvidence(value) {
  const result = {};
  for (const role of ['teacher', 'learner']) {
    const source = value?.[role];
    if (!source || typeof source !== 'object' || Array.isArray(source)) continue;
    const row = {};
    for (const key of ['parentPanelOpen', 'parentDetailsOpen', 'frameExposed', 'frameClipped',
      'nativeMode', 'otherToolOpen', 'panelHidden', 'panelOpen', 'buttonHidden', 'buttonDisabled', 'buttonVisible', 'busy',
      'privateHitButton', 'targetInFrameViewport', 'targetInParentViewport', 'framePointerEventsNone',
      'buttonPointerEventsNone', 'frameActive']) {
      if (typeof source[key] === 'boolean') row[key] = source[key];
    }
    for (const key of ['frameWidth', 'frameHeight', 'buttonWidth', 'buttonHeight', 'panelClientHeight',
      'panelScrollHeight', 'panelScrollTop', 'privateViewportHeight', 'privateViewportWidth', 'openDialogs',
      'parentDocumentsStarted', 'parentDocumentsFinished', 'parentDocumentsFailed', 'parentDocumentsPending']) {
      if (Number.isInteger(source[key]) && source[key] >= 0 && source[key] <= 100_000) row[key] = source[key];
    }
    for (const key of ['frameX', 'frameY', 'buttonTop', 'buttonBottom'])
      if (Number.isInteger(source[key]) && Math.abs(source[key]) <= 100_000) row[key] = source[key];
    if (['frame', 'header', 'dialog', 'overlay', 'footer', 'other', 'none'].includes(source.parentHitTarget))
      row.parentHitTarget = source.parentHitTarget;
    if (['loading', 'interactive', 'complete'].includes(source.parentDocumentState)) row.parentDocumentState = source.parentDocumentState;
    if (['login', 'lesson', 'other'].includes(source.parentDocumentKind)) row.parentDocumentKind = source.parentDocumentKind;
    if (source.catalog && typeof source.catalog === 'object' && !Array.isArray(source.catalog)) {
      const catalog = {};
      for (const key of ['timedOut', 'requestFailed']) if (source.catalog[key] === true) catalog[key] = true;
      const status = source.catalog.status;
      if (Number.isInteger(status) && status >= 100 && status <= 599) catalog.status = status;
      if (status === 200) {
        if (typeof source.catalog.canManage === 'boolean') catalog.canManage = source.catalog.canManage;
        for (const [key, maximum] of [['tags', 200], ['videos', 1000]])
          if (Number.isInteger(source.catalog[key]) && source.catalog[key] >= 0 && source.catalog[key] <= maximum)
            catalog[key] = source.catalog[key];
      }
      if (Object.keys(catalog).length) row.catalog = catalog;
    }
    if (Object.keys(row).length) result[role] = row;
  }
  return result;
}

// Media diagnostics contain only sizes, fixed transport classes and booleans.
// Never retain the URL, response headers, body or application error text.
export function mediaRangeEvidence(value) {
  const result = {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) return result;
  if (Number.isInteger(value.httpStatus) && value.httpStatus >= 100 && value.httpStatus <= 599)
    result.httpStatus = value.httpStatus;
  for (const key of ['bodyBytes', 'declaredBytes'])
    if (Number.isInteger(value[key]) && value[key] >= 0 && value[key] <= 100_000_000) result[key] = value[key];
  for (const key of ['offloaded', 'rangeMatches', 'mp4Prefix', 'htmlLike', 'developerWarning'])
    if (typeof value[key] === 'boolean') result[key] = value[key];
  if (['video', 'html', 'multipart', 'other'].includes(value.contentKind)) result.contentKind = value.contentKind;
  if (['identity', 'gzip', 'br', 'zstd', 'other'].includes(value.encoding)) result.encoding = value.encoding;
  return result;
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
  // Playwright records helper frames as absolute filesystem paths, while Node
  // can record their async callers as file URLs. Match both exact forms of the
  // same reviewed source so the first failing operation wins over its caller.
  const sources = [sourceUrl];
  try {
    if (new URL(sourceUrl).protocol === 'file:') sources.push(fileURLToPath(sourceUrl));
  } catch { /* A non-file source has no equivalent filesystem frame. */ }
  const escaped = sources.map(source => source.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
  const frame = new RegExp('(?:\\(|\\s)(?:' + escaped + '):(\\d{1,6}):(\\d{1,6})\\)?$');
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
