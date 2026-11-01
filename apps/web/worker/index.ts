import { NOT_FOUND_COPY, resolveFirstByteCopy } from '../src/lib/pageCopy';
import headerRules from '../public/_headers';
import { collectLandingEvent } from './landing-events';
import { serveLandingVideo } from './landing-media';
import {
  absoluteUrl,
  hreflangEntries,
  isNoindexPath,
  isPublicPath,
} from '../src/lib/seo';

function splitLocale(pathname: string): { locale: 'en' | 'ja'; path: string } {
  if (pathname === '/en' || pathname.startsWith('/en/')) {
    const rest = pathname.slice(3) || '/';
    return { locale: 'en', path: rest.startsWith('/') ? rest : `/${rest}` };
  }
  return { locale: 'ja', path: pathname || '/' };
}

// The shared _headers file contains one global /* rule. Apply it to generated
// responses too: Workers Static Assets only applies it to asset responses.
const securityHeaders = [...headerRules.matchAll(/^[ \t]+([^:\r\n]+):[ \t]*(.+)$/gm)]
  .map(([, name, value]) => [name.trim(), value.trim()] as const);

function isHtml(response: Response): boolean {
  return (response.headers.get('content-type') ?? '').includes('text/html');
}

async function serve(request: Request, env: WebEnv): Promise<Response> {
  const url = new URL(request.url);
  const { pathname } = url;

  if (url.hostname === 'www.videoq.jp') {
    url.protocol = 'https:';
    url.hostname = 'videoq.jp';
    url.port = '';
    return Response.redirect(url.href, 301);
  }

  if (pathname === '/__events/landing') {
    return collectLandingEvent(request, env.ENVIRONMENT);
  }
  if (/^\/demo\/(explain|student-demo|provider-demo)-(ja|en)\.mp4$/.test(pathname)) {
    return serveLandingVideo(request, env.ASSETS);
  }

  if (pathname === '/ja' || pathname === '/ja/' || pathname.startsWith('/ja/')) {
    const rest = pathname === '/ja' || pathname === '/ja/' ? '/' : pathname.slice(3);
    // Assign the pathname so /ja//example.com cannot become an external redirect.
    url.pathname = rest;
    return Response.redirect(url.href, 301);
  }

  // Production API routes run before this custom-domain Worker. Do not mask
  // missing API routes with the SPA, or connect public previews to production.
  if (pathname === '/api' || pathname.startsWith('/api/') ||
      pathname === '/.well-known' || pathname.startsWith('/.well-known/') ||
      pathname === '/health' || pathname === '/ready') {
    return new Response('Not Found', { status: 404 });
  }

  const { locale, path } = splitLocale(pathname);
  // One URL per page, so crawlers never split signals across slash variants.
  if (pathname === '/en' || (pathname.length > 1 && pathname !== '/en/' && pathname.endsWith('/'))) {
    url.pathname = pathname === '/en' ? '/en/' : `/${pathname.replace(/^\/+|\/+$/g, '')}`;
    return Response.redirect(url.href, 301);
  }
  const shell = () => env.ASSETS.fetch(new URL('/app-shell', url));
  // HTMLRewriter cannot transform the bodyless response to HEAD. Render as GET;
  // the response wrapper below drops the body again.
  const assetRequest = request.method === 'HEAD' ? new Request(request, { method: 'GET' }) : request;
  const isApp = !isPublicPath(path) && isNoindexPath(path);
  let response = isApp ? await shell() : await env.ASSETS.fetch(assetRequest);
  // Unknown paths answer 404 and the same React app renders the message. The
  // shell's own URL lands here too, so it cannot be indexed as a page.
  const notFound = !isApp && (response.status === 404 || (!isPublicPath(path) && isHtml(response)));
  if (notFound) {
    const { body, headers } = await shell();
    response = new Response(body, { status: 404, headers });
  }
  if (!isHtml(response)) {
    return response;
  }

  const copy = notFound ? NOT_FOUND_COPY[locale] : resolveFirstByteCopy(locale, path);
  const robots = env.ENVIRONMENT !== 'production' || notFound || isNoindexPath(path)
    ? 'noindex, nofollow' : 'index, follow';
  const canonical = absoluteUrl(path, locale);
  const alternates = hreflangEntries(path);

  const rewritten = new HTMLRewriter()
    .on('html', {
      element(el) {
        el.setAttribute('lang', locale);
      },
    })
    .on('title', {
      element(el) {
        el.setInnerContent(copy.title);
      },
    })
    .on('meta[name="description"]', {
      element(el) {
        el.setAttribute('content', copy.description);
      },
    })
    .on('meta[name="robots"]', {
      element(el) {
        el.setAttribute('content', robots);
      },
    })
    .on('meta[property="og:title"]', {
      element(el) {
        el.setAttribute('content', copy.title);
      },
    })
    .on('meta[property="og:description"]', {
      element(el) {
        el.setAttribute('content', copy.description);
      },
    })
    .on('meta[property="og:locale"]', {
      element(el) {
        el.setAttribute('content', locale === 'ja' ? 'ja_JP' : 'en_US');
      },
    })
    .on('meta[property="og:url"]', {
      element(el) {
        el.setAttribute('content', canonical);
      },
    })
    .on('link[rel="canonical"]', {
      element(el) {
        el.setAttribute('href', canonical);
      },
    })
    .on('link[rel="alternate"][hreflang]', {
      element(el) {
        const lang = el.getAttribute('hreflang');
        const match = alternates.find((entry) => entry.lang === lang);
        if (match) el.setAttribute('href', match.href);
      },
    })
    .transform(response);
  // The source asset validator does not describe the rewritten representation.
  rewritten.headers.delete('etag');
  rewritten.headers.delete('content-length');
  return rewritten;
}

export default {
  async fetch(request, env) {
    const original = await serve(request, env);
    const response = new Response(request.method === 'HEAD' ? null : original.body, original);
    for (const [name, value] of securityHeaders) response.headers.set(name, value);
    if (env.ENVIRONMENT !== 'production') {
      response.headers.set('X-Robots-Tag', 'noindex, nofollow');
    }
    return response;
  },
} satisfies ExportedHandler<WebEnv>;
