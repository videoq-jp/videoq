// Test-only preload for the actual maintenance CLI. Forward the original fetch
// unchanged; never read or publish URLs, headers, credentials or response bodies.
export function serviceFailure(input, response, error) {
  let url;
  try {url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);} catch {return null;}
  if (url.origin !== 'https://moodle.localhost:18443') return null;
  const service = {'/local/videoq/token.php': 'moodle-oauth', '/local/videoq/materials.php': 'moodle-materials'}[url.pathname];
  if (!service) return null;
  if (response && Number.isInteger(response.status) && response.status >= 400 && response.status <= 599)
    return {service, httpStatus: response.status};
  if (!error) return null;
  const known = new Set(['ERR_TLS_CERT_ALTNAME_INVALID', 'CERT_HAS_EXPIRED', 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
    'SELF_SIGNED_CERT_IN_CHAIN', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
    'ECONNREFUSED', 'ECONNRESET', 'EHOSTUNREACH', 'ENETUNREACH', 'EAI_AGAIN', 'ENOTFOUND', 'ETIMEDOUT', 'ABORT_ERR',
    'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_SOCKET']);
  const code = [error.code, error.cause?.code, ...(Array.isArray(error.cause?.errors) ? error.cause.errors.slice(0, 8).map(item => item?.code) : [])]
    .find(value => typeof value === 'string' && known.has(value));
  return {service, requestFailed: true, requestKind: error.name === 'TimeoutError' ? 'timeout' : 'error', ...(code ? {code} : {})};
}

export function observeMaintenanceFetch(original, emit) {
  return async (input, options) => {
    let response;
    try {response = await original(input, options);}
    catch (error) {
      const failure = serviceFailure(input, null, error);
      if (failure) emit(failure);
      throw error;
    }
    const failure = serviceFailure(input, response, null);
    if (failure) emit(failure);
    return response;
  };
}

// Importing this module in unit tests does not replace global fetch. The owned
// CLI selects the preload explicitly with this process-only environment flag.
if (process.env.VIDEOQ_MOODLE_CPU_OBSERVER === '1') {
  globalThis.fetch = observeMaintenanceFetch(globalThis.fetch.bind(globalThis),
    evidence => process.stderr.write('VIDEOQ_CPU_HTTP ' + JSON.stringify(evidence) + '\n'));
}
