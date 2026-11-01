export interface GuideEntry {
  slug: string;
  published: string;
  /** Change only when the guide's content actually changes: the sitemap publishes it. */
  updated: string;
  ja: { title: string; description: string };
  en: { title: string; description: string };
}

/** One page per search intent. See docs/operations/seo.md before adding another. */
export const GUIDE_CATALOG: readonly GuideEntry[] = [
  {
    slug: 'online-course-questions',
    published: '2026-10-31',
    updated: '2026-10-31',
    ja: {
      title: '動画講座の質問対応をAIで軽くする方法',
      description: 'オンライン講座の受講生から届く質問に、講義動画をもとにAIで答える方法を解説。共有リンクと招待の選び方、費用の負担者、回答を確認する手順、導入前の注意点をまとめました。',
    },
    en: {
      title: 'How to reduce online course support with AI answers',
      description: 'How to answer online course questions with AI grounded in your lecture videos: choosing share links or invitations, who pays for answers, how to check them, and what to confirm first.',
    },
  },
  {
    slug: 'class-recordings-for-review',
    published: '2026-10-31',
    updated: '2026-10-31',
    ja: {
      title: '授業の録画を、生徒が質問できる復習教材にする方法',
      description: '塾やスクールの授業録画を、欠席した回や試験前の復習に使える教材にする手順を解説。単元ごとの講座の分け方、生徒への共有方法、質問履歴の活かし方、事前に伝えておきたいことをまとめました。',
    },
    en: {
      title: 'How to turn class recordings into review material students can ask',
      description: 'Turn class recordings into review material for missed lessons and exam prep: organizing courses by unit, sharing with students, using question history, and what to tell students first.',
    },
  },
  {
    slug: 'training-video-questions',
    published: '2026-10-31',
    updated: '2026-10-31',
    ja: {
      title: '社内研修の動画に質問できるようにする方法',
      description: '研修動画の内容をあとから探す手間を減らす方法を解説。研修ごとの講座のつくり方、招待で閲覧者を限定する手順、質問者の確認範囲、社内で導入する前に決めておきたいことをまとめました。',
    },
    en: {
      title: 'How to let staff ask questions about training videos',
      description: 'Help staff find answers in training videos: building a course per program, restricting access with invitations, what question history shows, and what to decide before rolling it out.',
    },
  },
  {
    slug: 'how-ai-answers-work',
    published: '2026-10-31',
    updated: '2026-10-31',
    ja: {
      title: 'VideoQのAI回答の仕組みと、確認しておきたいこと',
      description: 'VideoQが講義動画をもとにAI回答を作る流れを解説。文字起こしから引用する場面の表示まで、回答に誤りが含まれる場合の確認方法、受講生の質問を誰が閲覧できるかを説明します。',
    },
    en: {
      title: 'How VideoQ AI answers work and what to check',
      description: 'How VideoQ builds AI answers from your lecture videos, from transcription to the cited moment, how to check for mistakes, and who can read the questions students ask.',
    },
  },
];

export function guidePath(slug: string): string {
  return `/guides/${slug}`;
}

export function guideBySlug(slug: string | undefined): GuideEntry | undefined {
  return GUIDE_CATALOG.find(guide => guide.slug === slug);
}
