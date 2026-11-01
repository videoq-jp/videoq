import { serializeJsonLd } from '@/lib/seo';

/** Rendered with the page body, so client navigation never leaves another page's data behind. */
export function StructuredData({ data }: { data: unknown }) {
  return <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: serializeJsonLd(data) }} />;
}
