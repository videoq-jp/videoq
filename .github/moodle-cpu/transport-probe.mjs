// Actual Node DNS/TLS/HTTP against the owned Moodle fixture. No credentials,
// HTTP bodies, model services or substituted responses are used by this probe.
import dns from 'node:dns/promises';
import tls from 'node:tls';
import {isIP} from 'node:net';
import {readFileSync} from 'node:fs';

export const networkCodes = new Set(['EAI_AGAIN', 'ENOTFOUND', 'ENODATA', 'ESERVFAIL', 'EREFUSED', 'ETIMEOUT',
  'ECONNREFUSED', 'ECONNRESET', 'EHOSTUNREACH', 'ENETUNREACH', 'ETIMEDOUT', 'ABORT_ERR',
  'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_SOCKET',
  'ERR_TLS_CERT_ALTNAME_INVALID', 'CERT_HAS_EXPIRED', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY', 'SELF_SIGNED_CERT_IN_CHAIN', 'DEPTH_ZERO_SELF_SIGNED_CERT']);

export function transportError(error) {
  const codes = new Set();
  function visit(value, depth) {
    if (!value || typeof value !== 'object' || depth > 3) return;
    if (networkCodes.has(value.code)) codes.add(value.code);
    visit(value.cause, depth + 1);
    if (Array.isArray(value.errors)) for (const item of value.errors.slice(0, 8)) visit(item, depth + 1);
  }
  visit(error, 0);
  return {kind: error?.name === 'TimeoutError' || error?.name === 'AbortError' ? 'timeout' : 'error', codes: [...codes]};
}

async function lookup(expected, resolve) {
  let timer;
  try {
    const rows = await Promise.race([resolve(), new Promise((_, reject) => {
      timer = setTimeout(() => reject(new DOMException('Owned lookup deadline', 'TimeoutError')), 15000);
    })]);
    return {ok: true, proxyMatched: rows.length === 1 && rows[0] === expected};
  } catch (error) {return {ok: false, ...transportError(error)};}
  finally {clearTimeout(timer);}
}

async function httpsProbe(path, method) {
  try {
    const response = await fetch('https://moodle.localhost:18443' + path, {
      method, redirect: 'error', signal: AbortSignal.timeout(10000),
      ...(method === 'POST' ? {headers: {'Content-Type': 'application/x-www-form-urlencoded'}, body: ''} : {}),
    });
    await response.body?.cancel().catch(() => {});
    return {ok: true, httpStatus: response.status};
  } catch (error) {return {ok: false, ...transportError(error)};}
}

async function tlsProbe() {
  return new Promise(resolve => {
    const result = {ok: false, lookup: false, connected: false, secure: false};
    let finished = false;
    let timer;
    const socket = tls.connect({host: 'moodle.localhost', port: 18443,
      servername: 'moodle.localhost', rejectUnauthorized: true});
    function finish() {if (!finished) {finished = true; clearTimeout(timer); socket.destroy(); resolve(result);}}
    socket.on('lookup', () => {if (!finished) result.lookup = true;});
    socket.on('connect', () => {if (!finished) result.connected = true;});
    socket.on('secureConnect', () => {if (!finished) {result.secure = true; result.ok = socket.authorized === true; finish();}});
    socket.on('error', error => {if (!finished) {Object.assign(result, transportError(error)); finish();}});
    timer = setTimeout(() => {result.kind = 'timeout'; finish();}, 10000);
  });
}

if (process.env.VIDEOQ_MOODLE_TRANSPORT_PROBE === '1') {
  const expected = process.env.VIDEOQ_MOODLE_EXPECTED_PROXY;
  const parts = (expected ?? '').split('.').map(Number);
  if (isIP(expected ?? '') !== 4 || parts[0] !== 10 || parts[1] < 96 || parts[1] > 111)
    throw new Error('Owned proxy address required');
  const ndots = readFileSync('/etc/resolv.conf', 'utf8').match(/\bndots:(\d{1,2})\b/);
  const report = {nodeVersion: process.version, dnsNdots: ndots ? Number(ndots[1]) : null,
    lookup: await lookup(expected, async () => (await dns.lookup('moodle.localhost', {all: true})).map(row => row.address)),
    resolve4: await lookup(expected, () => dns.resolve4('moodle.localhost')),
    tls: await tlsProbe(), login: await httpsProbe('/login/index.php', 'GET'),
    oauth: await httpsProbe('/local/videoq/token.php', 'POST')};
  const passed = report.lookup.ok && report.lookup.proxyMatched && report.resolve4.ok && report.resolve4.proxyMatched
    && report.tls.ok && report.login.ok && report.login.httpStatus === 200 && report.oauth.ok && report.oauth.httpStatus === 401;
  report.status = passed ? 'passed' : 'failed';
  console.log(JSON.stringify(report));
  process.exit(passed ? 0 : 1);
}
