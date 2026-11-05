import { describe, expect, it } from 'vitest';
import { moodleConnectCallback, moodleConnectRequest } from '../moodleConnect';

const state = 'a'.repeat(64);
const challenge = 'b'.repeat(43);
const query = (url: string) => '?' + new URLSearchParams({ moodle_url: url, state, code_challenge: challenge }).toString();

describe('Moodle connection return destination', () => {
  it.each(['https://moodle.example', 'https://private.example:9443/academy'])('returns only to the requesting Moodle callback: %s', url => {
    const request = moodleConnectRequest(query(url))!;
    const target = new URL(moodleConnectCallback(request, { code: 'c'.repeat(64) }));
    expect(target.origin).toBe(new URL(url).origin);
    expect(target.pathname).toBe(new URL(url).pathname.replace(/\/$/, '') + '/local/videoq/connect.php');
    expect(target.searchParams.get('code')).toBe('c'.repeat(64));
    expect(target.searchParams.get('state')).toBe(state);
    expect(new URL(moodleConnectCallback(request, { error: 'access_denied' })).searchParams.has('code')).toBe(false);
  });
  it.each(['http://moodle.example', '//evil.example', 'https://u:p@moodle.example', 'https://moodle.example?redirect=https://evil.example', 'https://moodle.example/#evil', 'https://moodle.example\\@evil.example'])('rejects ambiguous or unsafe URLs: %s', url => {
    expect(moodleConnectRequest(query(url))).toBeNull();
  });
  it('requires exactly one state, challenge and Moodle URL', () => {
    const valid = query('https://moodle.example');
    for (const suffix of ['&state=' + state, '&code_challenge=' + challenge, '&moodle_url=https://other.example']) expect(moodleConnectRequest(valid + suffix)).toBeNull();
    expect(moodleConnectRequest(valid.replace(state, 'short'))).toBeNull();
    expect(moodleConnectRequest(valid.replace(challenge, 'short'))).toBeNull();
    expect(moodleConnectRequest('')).toBeNull();
  });
});
