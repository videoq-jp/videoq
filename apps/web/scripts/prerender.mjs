// Writes each public page's body into its first HTML response. The Worker rewrites
// the head (title, canonical, hreflang, robots) on the way out, from one source.
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'vite';

if (process.env.VITE_DEPLOYMENT_EDITION === 'onprem') process.exit(0);

const web = resolve(import.meta.dirname, '..');
const dist = resolve(web, 'dist');
const bundle = resolve(web, 'node_modules/.cache/videoq-prerender');
const ROOT = '<div id="root"></div>';

await build({
  configFile: false,
  root: web,
  publicDir: false,
  logLevel: 'error',
  resolve: { alias: [{ find: '@', replacement: resolve(web, 'src') }] },
  ssr: { noExternal: true },
  build: { ssr: 'src/entry-prerender.tsx', outDir: bundle, emptyOutDir: true, minify: false },
});
const { buildSitemap, localizedPath, publicPaths, renderPage } = await import(pathToFileURL(resolve(bundle, 'entry-prerender.js')).href);

const template = await readFile(resolve(dist, 'index.html'), 'utf8');
if (!template.includes(ROOT)) throw new Error('Client build has no empty root element');
// Application routes keep the empty document; only they may start from nothing.
await rename(resolve(dist, 'index.html'), resolve(dist, 'app-shell.html'));

const pageFile = url => url.endsWith('/') ? `${url}index.html` : `${url}.html`;
for (const path of publicPaths()) {
  for (const locale of ['ja', 'en']) {
    const url = localizedPath(path, locale);
    const body = await renderPage(url, locale);
    if (!/<h1[\s>]/.test(body)) throw new Error(`Prerendered ${url} has no heading`);
    // The CSP blocks inline scripts, so one here would break hydration in production.
    if (/<script(?![^>]*type="application\/ld\+json")/.test(body)) throw new Error(`Prerendered ${url} has an inline script`);
    const html = template.replace(ROOT, () => `<div id="root">${body}</div>`).replace(/\s*<noscript>[\s\S]*?<\/noscript>/, '');
    const file = resolve(dist, `.${pageFile(url)}`);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, html);
  }
}
await writeFile(resolve(dist, 'sitemap.xml'), buildSitemap());
await rm(bundle, { recursive: true, force: true });
// React's stream and tRPC clients may hold handles that would delay a build exit.
process.exit(0);
