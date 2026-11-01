/// <reference types="node" />
import { Readable } from 'node:stream';
import { text } from 'node:stream/consumers';
import type { ReactNode } from 'react';
import { prerenderToNodeStream } from 'react-dom/static';
import { StaticRouter } from 'react-router-dom';
import i18n from '@/i18n/config';
import { AppRoot } from '@/AppRoot';
import { type SiteLocale } from '@/lib/seo';

export { buildSitemap, localizedPath, publicPaths } from '@/lib/seo';

/** Waits for lazy routes so the HTML holds the page body, not a loading fallback. */
export async function renderPage(url: string, locale: SiteLocale): Promise<string> {
  await i18n.changeLanguage(locale);
  const Router = ({ children }: { children: ReactNode }) => <StaticRouter location={url}>{children}</StaticRouter>;
  // React outlines large boundaries and moves them with inline scripts, which the
  // site's CSP (script-src 'self') blocks. Keep every boundary in document order.
  const { prelude } = await prerenderToNodeStream(<AppRoot router={Router} />, { progressiveChunkSize: Number.MAX_SAFE_INTEGER });
  return text(prelude as Readable);
}
