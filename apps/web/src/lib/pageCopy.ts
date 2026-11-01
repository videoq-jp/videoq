import { guideBySlug, guidePath } from './guideCatalog';
import { normalizePathname, type SiteLocale } from './seo';

export const DEFAULT_COPY: Record<SiteLocale, { title: string; description: string }> = {
  "ja": {
    "title": "動画講座の質問対応を自動化 | VideoQ",
    "description": "動画講座の運営者・講師の方へ。講義動画をアップするだけで、受講生の質問に動画の内容から自動で回答します。回答には講義の該当場面が付き、受講生はリンクを開くだけで質問できます。講義1本から無料で試せます。"
  },
  "en": {
    "title": "Answer online course questions from your lecture videos | VideoQ",
    "description": "For course creators and instructors. Upload your lecture videos and student questions get answered automatically, right from your lectures. Every answer links to the source moment, and students just open a link to ask. Try it free with one lecture."
  }
};

const PAGE_COPY: Record<SiteLocale, Record<string, { title: string; description: string }>> = {
  ja: {
    '/try': { title: '登録なしで試す | VideoQ', description: 'サンプル講座に、受講生の立場で質問できます。回答には講義の該当場面が付きます。登録は不要です。' },
    '/pricing': {
      title: '料金プラン | VideoQ',
      description: '講義1本で試せる Free から、講座を運営する Basic、複数の講座や研修をまとめて扱う Pro まで。年払いは 2 ヶ月分お得です。',
    },
    '/guides': {
      title: '動画講座の質問対応ガイド | VideoQ',
      description: '動画講座や授業の録画、社内研修で、受講生の質問に講義動画で答える方法をまとめたガイドです。公開手順、共有範囲、AI回答の確認方法を説明します。',
    },
    '/terms': { title: '利用規約 | VideoQ', description: 'VideoQ の利用規約です。' },
    '/privacy': { title: 'プライバシーポリシー | VideoQ', description: 'VideoQ のプライバシーポリシーです。' },
    '/refund': { title: '返金・キャンセル | VideoQ', description: 'VideoQ の返金およびキャンセル方針です。' },
    '/legal': { title: '特定商取引法に基づく表記 | VideoQ', description: '特定商取引法に基づく表記です。' },
    '/login': { title: 'ログイン | VideoQ', description: DEFAULT_COPY.ja.description },
    '/signup': { title: '新規登録 | VideoQ', description: DEFAULT_COPY.ja.description },
  },
  en: {
    '/try': { title: 'Try it without signing up | VideoQ', description: 'Ask a sample course a question as a student would. Every answer links to the source moment. No signup needed.' },
    '/pricing': {
      title: 'Pricing | VideoQ',
      description:
        'Try Free with one lecture, run a course with Basic, or manage multiple courses and training programs with Pro. Annual billing saves two months.',
    },
    '/guides': {
      title: 'Guides to answering course questions | VideoQ',
      description: 'Guides to answering student questions from your lecture videos, for online courses, class recordings and staff training: setup, sharing and checking AI answers.',
    },
    '/terms': { title: 'Terms of Service | VideoQ', description: 'VideoQ terms of service.' },
    '/privacy': { title: 'Privacy Policy | VideoQ', description: 'VideoQ privacy policy.' },
    '/refund': { title: 'Refunds and cancellation | VideoQ', description: 'VideoQ refund and cancellation policy.' },
    '/legal': {
      title: 'Specified Commercial Transactions Act notice | VideoQ',
      description: 'Notice under the Specified Commercial Transactions Act.',
    },
    '/login': { title: 'Log in | VideoQ', description: DEFAULT_COPY.en.description },
    '/signup': { title: 'Sign up | VideoQ', description: DEFAULT_COPY.en.description },
  },
};

export const NOT_FOUND_COPY: Record<SiteLocale, { title: string; description: string }> = {
  ja: { title: 'ページが見つかりません | VideoQ', description: 'お探しのページは見つかりませんでした。URLをご確認ください。' },
  en: { title: 'Page not found | VideoQ', description: 'The page you are looking for could not be found. Check the URL.' },
};

export function resolveFirstByteCopy(
  locale: SiteLocale,
  path: string,
): { title: string; description: string } {
  path = normalizePathname(path);
  const exact = PAGE_COPY[locale][path];
  if (exact) return exact;

  const slug = path.match(/^\/guides\/([^/]+)$/)?.[1];
  const guide = slug ? guideBySlug(slug) : undefined;
  if (guide && guidePath(guide.slug) === path) {
    return { title: `${guide[locale].title} | VideoQ`, description: guide[locale].description };
  }

  return DEFAULT_COPY[locale];
}
