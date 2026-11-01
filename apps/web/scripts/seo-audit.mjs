// Read-only audit of the HTML actually served to crawlers. Works against a local
// Worker with --base-url. It cannot measure Google indexing, rankings or field
// Core Web Vitals, and it never changes production content.
import { writeFile } from 'node:fs/promises';
import { rootText } from './html-text.mjs';

const args = process.argv.slice(2);
const option = (name, fallback) => args.includes(name) ? args[args.indexOf(name) + 1] : fallback;
const base = new URL(option('--base-url', 'https://videoq.jp'));
const output = option('--output', 'seo-audit.json');
const canonicalOrigin = 'https://videoq.jp';

const decode = text => text.replace(/&quot;/g, '"').replace(/&#x27;|&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
const tags = (html, name) => [...html.matchAll(new RegExp(`<${name}\\b[^>]*>`, 'gi'))].map(match => {
  const attributes = {};
  for (const part of match[0].matchAll(/([\w:-]+)\s*=\s*"([^"]*)"/g)) attributes[part[1].toLowerCase()] = decode(part[2]);
  return attributes;
});
const fetchPath = async (path, method = 'GET') => {
  const response = await fetch(new URL(path, base), { method, signal: AbortSignal.timeout(20_000), redirect: 'manual' });
  return { response, html: await response.text() };
};

const issues = [];
const add = (url, reason) => issues.push({ url, reason });
const sitemap = await fetchPath('/sitemap.xml');
if (sitemap.response.status !== 200) throw new Error(`Sitemap returned ${sitemap.response.status}`);
const urls = [...sitemap.html.matchAll(/<loc>(.*?)<\/loc>/g)].map(match => decode(match[1]));
if (!urls.length) throw new Error('Sitemap lists no URLs');
if (new Set(urls).size !== urls.length) add('/sitemap.xml', 'duplicate sitemap URLs');

const pages = [];
for (const url of urls) {
  const path = new URL(url).pathname;
  if (new URL(url).origin !== canonicalOrigin) add(url, 'noncanonical origin in sitemap');
  try {
    const { response, html } = await fetchPath(path);
    const head = await fetchPath(path, 'HEAD');
    const links = tags(html, 'link');
    const meta = tags(html, 'meta');
    const canonical = links.filter(tag => tag.rel === 'canonical');
    const alternates = links.filter(tag => tag.rel === 'alternate' && tag.hreflang);
    const descriptions = meta.filter(tag => tag.name === 'description');
    const titles = [...html.matchAll(/<title>([\s\S]*?)<\/title>/gi)].map(match => decode(match[1]));
    const h1s = html.match(/<h1[\s>]/gi) ?? [];
    const robots = `${meta.find(tag => tag.name === 'robots')?.content ?? ''} ${response.headers.get('x-robots-tag') ?? ''}`;
    const jsonld = [...html.matchAll(/<script\b[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi)];
    const anchors = tags(html, 'a').filter(tag => tag.href && !tag.href.startsWith('#')).map(tag => new URL(tag.href, url));
    const data = {
      url,
      status: response.status,
      title: titles[0],
      description: descriptions[0]?.content,
      canonical: canonical[0]?.href,
      h1Count: h1s.length,
      bodyTextLength: rootText(html).trim().length,
      structuredData: jsonld.length,
      links: anchors.filter(link => link.origin === canonicalOrigin).map(link => link.pathname),
    };
    pages.push(data);
    if (response.status !== 200) add(url, `HTTP ${response.status}`);
    if (head.response.status !== response.status) add(url, `HEAD answered ${head.response.status}, GET ${response.status}`);
    if (canonical.length !== 1 || canonical[0].href !== url) add(url, 'missing, duplicate or incorrect canonical');
    if (titles.length !== 1 || !titles[0].trim()) add(url, 'missing or duplicate title');
    if (descriptions.length !== 1 || !descriptions[0].content?.trim()) add(url, 'missing or duplicate description');
    if (h1s.length !== 1) add(url, `expected one H1, found ${h1s.length}`);
    if (/\bnoindex\b/i.test(robots)) add(url, 'sitemap page is noindex');
    if (data.bodyTextLength < 100) add(url, 'first HTML has almost no body text');
    if (!alternates.some(tag => tag.href === url)) add(url, 'hreflang set does not include the page itself');
    if (/^(\/(en\/)?|(\/en)?\/guides\/.+)$/.test(path) && !jsonld.length) add(url, 'no structured data');
    for (const match of jsonld) {
      try { JSON.parse(match[1]); } catch { add(url, 'invalid JSON-LD'); }
    }
    if (tags(html, 'img').some(image => image.alt === undefined)) add(url, 'image missing alt attribute');
  } catch (error) {
    add(url, error.message);
  }
}

const paths = new Set(urls.map(url => new URL(url).pathname));
const linked = new Set(pages.flatMap(page => page.links));
for (const page of pages) {
  const path = new URL(page.url).pathname;
  if (!['/', '/en/'].includes(path) && !linked.has(path)) add(page.url, 'no incoming link from any sitemap page');
  for (const link of new Set(page.links)) {
    if (/^(\/en)?\/guides(\/|$)/.test(link) && !paths.has(link)) add(page.url, `guide link absent from sitemap: ${link}`);
  }
}
for (const field of ['title', 'description', 'canonical']) {
  const groups = Map.groupBy(pages.filter(page => page[field]), page => page[field]);
  for (const [value, group] of groups) if (group.length > 1) add(group.map(page => page.url).join(', '), `duplicate ${field}: ${value}`);
}

const robots = await fetchPath('/robots.txt');
if (robots.response.status !== 200 || !robots.html.includes(`Sitemap: ${canonicalOrigin}/sitemap.xml`)) add('/robots.txt', 'missing sitemap declaration');
for (const path of ['/login', '/en/videos']) {
  const { response, html } = await fetchPath(path);
  if (response.status !== 200 || !/noindex/i.test(tags(html, 'meta').find(tag => tag.name === 'robots')?.content ?? '')) add(path, 'application route must answer 200 with noindex');
}
for (const path of ['/seo-audit-missing-page', '/en/seo-audit-missing-page', '/guides/seo-audit-missing-page']) {
  const { response } = await fetchPath(path);
  if (response.status !== 404) add(path, `expected 404, received ${response.status}`);
}

await writeFile(output, JSON.stringify({ checkedAt: new Date().toISOString(), baseUrl: base.origin, crawled: pages.length, issues, pages }, null, 2) + '\n');
console.log(JSON.stringify({ crawled: pages.length, issues: issues.length, output }));
for (const issue of issues) console.log(`${issue.url}: ${issue.reason}`);
if (issues.length) process.exitCode = 1;
