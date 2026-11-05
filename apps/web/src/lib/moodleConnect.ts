/** Fixed callback path: no caller-supplied redirect URI is accepted. */
export function moodleConnectRequest(search: string) {
  const params = new URLSearchParams(search);
  for (const key of ['moodle_url', 'state', 'code_challenge']) if (params.getAll(key).length !== 1) return null;
  const moodleUrl = params.get('moodle_url') ?? '';
  const state = params.get('state') ?? '';
  const codeChallenge = params.get('code_challenge') ?? '';
  if (!/^[a-f0-9]{64}$/.test(state) || !/^[A-Za-z0-9_-]{43}$/.test(codeChallenge)) return null;
  try {
    const url = new URL(moodleUrl);
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || /[\s\\]/.test(moodleUrl) || moodleUrl.length > 2048) return null;
    return { moodleUrl: url.href.replace(/\/+$/, ''), state, codeChallenge };
  } catch { return null; }
}

export function returnToMoodle(url: string) {
  window.location.replace(url);
}

export function moodleConnectCallback(request: NonNullable<ReturnType<typeof moodleConnectRequest>>, result: { code: string } | { error: string }) {
  const target = new URL(request.moodleUrl + '/local/videoq/connect.php');
  target.searchParams.set('state', request.state);
  if ('code' in result) target.searchParams.set('code', result.code);
  else target.searchParams.set('error', result.error);
  return target.href;
}
