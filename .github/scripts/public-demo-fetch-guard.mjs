import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { ORIGIN } = require('./public-demo-policy.cjs');
const { uploadAllowed } = require('./production-smoke-policy.cjs');
const allowed = new Set(['videos.list','videos.requestUpload','videos.confirmUpload','videos.get','courses.list','courses.create','courses.get','memberships.addVideo','courses.createShare','courses.shared']);
const original = globalThis.fetch;
globalThis.fetch = (input, options = {}) => {
  const url = new URL(input instanceof Request ? input.url : input);
  if (url.origin === ORIGIN) {
    if (!allowed.has(url.pathname.replace('/api/trpc/',''))) throw new Error('UNEXPECTED_DEMO_API_PROCEDURE');
  } else {
    const headers = new Headers(options.headers);
    if (!uploadAllowed(url.href) || options.method !== 'PUT' || headers.has('cookie') || headers.has('authorization')) throw new Error('UNEXPECTED_DEMO_UPLOAD');
  }
  return original(input, { ...options, redirect: 'error' });
};
