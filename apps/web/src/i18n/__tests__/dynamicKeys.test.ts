import ja from '../locales/ja/translation.json';
import en from '../locales/en/translation.json';

/**
 * `t(\`prefix.${value}\`)` の形で引かれる翻訳キーを、実際に来うる値と突き合わせる。
 *
 * この形は値が増えても型では守れず、画面に `...undefined` や生キーが
 * そのまま出るまで気づけない。バックエンドの enum を変えたら、ここが落ちる。
 */
const LOCALES = { ja, en } as const;

type KeyMap = Record<string, unknown>;

function resolve(locale: KeyMap, path: string): KeyMap {
  return path.split('.').reduce<KeyMap>((node, key) => {
    const next = node?.[key];
    if (!next || typeof next !== 'object') {
      throw new Error(`translation path not found: ${path} (at "${key}")`);
    }
    return next as KeyMap;
  }, locale);
}

/** キーのプレフィックス → バックエンドが返しうる値の網羅。 */
const DYNAMIC_KEYS: { path: string; values: readonly string[] }[] = [
  {
    // CourseInvitationPage: ステータスチップ
    path: 'courseInvitation.status',
    values: ['pending', 'accepted', 'declined', 'expired', 'revoked'],
  },
  {
    // CourseInvitationPage: 終了状態の説明。pending では描画されない。
    path: 'courseInvitation.terminal',
    values: ['accepted', 'declined', 'expired', 'revoked'],
  },
  {
    // CourseParticipantsDialog: 一括招待の宛先ごとの結果。
    // 送信はキューに載るため sent/send_failed は返らない。
    path: 'videos.courseMembers.result',
    values: ['queued', 'already_member', 'already_invited', 'invalid', 'duplicate'],
  },
  {
    path: 'videos.courseMembers.status',
    values: ['pending', 'accepted', 'declined', 'expired', 'revoked'],
  },
  {
    path: 'videos.courseMembers.delivery',
    values: ['queued', 'sent', 'failed'],
  },
];

describe('動的に組み立てる翻訳キー', () => {
  describe.each(Object.entries(LOCALES))('%s', (_name, locale) => {
    it.each(DYNAMIC_KEYS)('$path が全ての値を網羅する', ({ path, values }) => {
      const node = resolve(locale, path);

      // 値が増えたのに翻訳を足し忘れると、画面に生キーが出る。
      expect(Object.keys(node).sort()).toEqual([...values].sort());

      for (const value of values) {
        expect(typeof node[value]).toBe('string');
        expect(node[value]).not.toBe('');
      }
    });
  });
});
