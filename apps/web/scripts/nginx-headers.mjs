// Generate nginx's template from the same policy used by the Cloudflare Worker.
import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export function nginxHeaders(source, apiUrl = '/api') {
  const headers = [...source.matchAll(/^[ \t]+([^:\r\n]+):[ \t]*(.+)$/gm)];
  if (!headers.some(([, name]) => name === 'Content-Security-Policy')) {
    throw new Error('The shared _headers file must define a CSP');
  }
  let apiOrigin = '';
  if (!apiUrl.startsWith('/')) {
    const url = new URL(apiUrl);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
      throw new Error('VITE_API_URL must be an HTTP(S) URL without credentials');
    }
    apiOrigin = url.origin;
  }
  return headers.map(([, name, raw]) => {
    let value = raw.trim();
    if (name === 'Content-Security-Policy') {
      value = value.split(';').map(part => {
        const directive = part.trim();
        return /^(connect|media|img)-src\b/.test(directive)
          ? `${directive}${apiOrigin ? ` ${apiOrigin}` : ''} \${VIDEOQ_CSP_STORAGE_ORIGINS}`
          : directive;
      }).join('; ');
    }
    return `add_header ${name} "${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}" always;`;
  }).join('\n') + '\n';
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const source = readFileSync(new URL('../public/_headers', import.meta.url), 'utf8');
  writeFileSync(process.argv[2], nginxHeaders(source, process.env.VITE_API_URL));
}
