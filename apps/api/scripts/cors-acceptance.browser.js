const prefix = document.body.dataset.prefix;
const role = document.body.dataset.role;
const button = document.querySelector('button');
const output = document.querySelector('pre');
const assert = value => { if (!value) throw new Error('Fixture assertion failed'); };
button.addEventListener('click', async () => {
  button.disabled = true;
  const rows = [];
  const check = async (name, run) => {
    try { rows.push({ name, passed: true, ...await run() }); }
    catch { rows.push({ name, passed: false }); }
    output.textContent = JSON.stringify({ role, rows }, null, 2);
  };
  const blocked = async (url, options) => {
    try { await fetch(url, options); return false; }
    catch (error) { return error instanceof TypeError; }
  };
  const config = await (await fetch(`${prefix}/fixtures`, { method: 'POST' })).json();
  const api = config.api;
  if (role === 'allowed') {
    await check('cookie-omitted-401-readable', async () => {
      const response = await fetch(`${api}/cookie`, { credentials: 'omit' });
      assert(response.status === 401 && response.headers.get('x-request-id') === 'cors-probe');
      return { status: response.status };
    });
    await check('cookie-set-cross-origin', async () => {
      const response = await fetch(`${api}/session`, { credentials: 'include' });
      assert(response.status === 200); return { status: response.status };
    });
    await check('cookie-included-json-preflight', async () => {
      const response = await fetch(`${api}/write?role=${role}`, { method: 'POST', credentials: 'include',
        headers: { 'content-type': 'application/json' }, body: '{}' });
      const body = await response.json(); assert(response.status === 200 && body.cookie === true);
      return { status: response.status };
    });
    await check('api-error-500-readable', async () => {
      const response = await fetch(`${api}/error`, { credentials: 'include' });
      assert(response.status === 500 && (await response.json()).code === 'SYNTHETIC_ERROR');
      return { status: response.status };
    });
    await check('signed-put-and-exposed-etag', async () => {
      const response = await fetch(config.put, { method: 'PUT', credentials: 'omit',
        headers: { 'content-type': 'video/mp4' }, body: new Uint8Array(31).fill(7) });
      assert(response.status === 200 && !!response.headers.get('etag'));
      return { status: response.status, etagReadable: true };
    });
    await check('storage-signature-error-403-readable', async () => {
      const response = await fetch(config.wrongType, { method: 'PUT', credentials: 'omit',
        headers: { 'content-type': 'application/octet-stream' }, body: new Uint8Array(31).fill(7) });
      assert(response.status === 403); await response.text(); return { status: response.status };
    });
    const etags = [];
    await check('multipart-two-browser-parts', async () => {
      for (let index = 0; index < config.parts.length; index++) {
        const part = config.parts[index];
        const response = await fetch(part.url, { method: 'PUT', credentials: 'omit',
          headers: { 'content-type': 'video/mp4' }, body: new Uint8Array(part.size).fill(part.value) });
        const etag = response.headers.get('etag'); assert(response.status === 200 && !!etag);
        etags.push({ partNumber: index + 1, etag: etag.replace(/^"|"$/g, '') });
      }
      return { parts: etags.length, etagReadable: true };
    });
    await check('multipart-complete-and-byte-readback', async () => {
      assert(etags.length === 2);
      const response = await fetch(`${api}/complete`, { method: 'POST', credentials: 'include',
        headers: { 'content-type': 'application/json' }, body: JSON.stringify({ fixture: config.id, parts: etags }) });
      const body = await response.json(); assert(response.status === 200 && body.size === config.expectedSize && body.hashMatches);
      return { status: response.status, size: body.size, hashMatches: true };
    });
  } else {
    await check('denied-api-cookie-read-blocked', async () => {
      assert(await blocked(`${api}/cookie`, { credentials: 'include' })); return { browserBlocked: true };
    });
    await check('denied-api-json-preflight-blocked', async () => {
      assert(await blocked(`${api}/write?role=${role}`, { method: 'POST', credentials: 'include',
        headers: { 'content-type': 'application/json' }, body: '{}' })); return { browserBlocked: true };
    });
    await check('denied-storage-put-preflight-blocked', async () => {
      assert(await blocked(config.put, { method: 'PUT', credentials: 'omit',
        headers: { 'content-type': 'video/mp4' }, body: new Uint8Array(31).fill(7) })); return { browserBlocked: true };
    });
  }
  const mcp = { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer synthetic',
    dpop: 'synthetic', 'mcp-protocol-version': '2025-06-18' }, body: '{}' };
  await check('mcp-without-cookies-401-challenge-readable', async () => {
    const response = await fetch(config.mcp, { ...mcp, credentials: 'omit' });
    assert(response.status === 401 && response.headers.get('www-authenticate') === 'Bearer realm="synthetic"');
    return { status: response.status, challengeReadable: true };
  });
  await check('mcp-wildcard-does-not-permit-cookie-mode', async () => {
    assert(await blocked(config.mcp, { ...mcp, credentials: 'include' })); return { browserBlocked: true };
  });
  await fetch(`${prefix}/results`, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ role, origin: location.origin, browser: navigator.userAgent, rows }) });
  document.body.dataset.done = 'true';
  document.body.dataset.passed = String(rows.every(row => row.passed));
});
