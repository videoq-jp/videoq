export const THROTTLE_RATES = {
  skill_start_user: { limit: 10, periodSec: 86400 },
  skill_step_user: { limit: 180, periodSec: 3600 },
  moodle_pairing_ip: { limit: 30, periodSec: 600 },
  moodle_pairing_user: { limit: 20, periodSec: 3600 },
  // Hundreds of learners can share one school/NAT address. The sustained
  // question allowance is enforced separately on each verified LTI subject.
  lti_request_ip: { limit: 1200, periodSec: 60 },
  lti_launch_ip: { limit: 1200, periodSec: 3600 },
  course_qa_read: { limit: 600, periodSec: 3600 },
  course_qa_write: { limit: 120, periodSec: 3600 },
  chat_share_token_ip: { limit: 100, periodSec: 3600 },
  // 公開デモは誰でも開けるので、1 人が所有者の回答枠を使い切れないよう狭くする。
  chat_public_demo_ip: { limit: 10, periodSec: 3600 },
  chat_authenticated: { limit: 300, periodSec: 3600 },
  login_ip: { limit: 5, periodSec: 60 },
  login_username: { limit: 5, periodSec: 60 },
  signup_ip: { limit: 3, periodSec: 3600 },
  signup_email: { limit: 3, periodSec: 3600 },
  password_reset_ip: { limit: 3, periodSec: 3600 },
  password_reset_email: { limit: 3, periodSec: 3600 },
  email_change_user: { limit: 3, periodSec: 3600 },
  email_change_email: { limit: 3, periodSec: 3600 },
  // 招待は「リクエスト数」ではなく「宛先数」で消費する（1 回 50 件 × 10 回で
  // 500 通送れてしまうのを防ぐ）。
  course_invitation_user: { limit: 200, periodSec: 3600 },
  course_invitation_course: { limit: 200, periodSec: 3600 },
  course_invitation_resend: { limit: 3, periodSec: 3600 },
  // トークン式エンドポイントは未認証で叩けるので、IP 単位で総当り・負荷を絞る。
  course_invitation_token_ip: { limit: 60, periodSec: 3600 },
  course_invitation_decision_user: { limit: 30, periodSec: 3600 },
  // 共有スラッグは利用者が決める短い文字列なので推測できる。解決に「失敗した」
  // 試行だけを絞り、正規の共有視聴（Range 連打）には一切かけない。
  share_slug_probe_ip: { limit: 30, periodSec: 3600 },
  // MCP は HTTP 200 内に tool error を返すため、transport の外ではなく
  // tool 実行直前に user 単位で消費する。書き込みは重く副作用もあるので厳しくする。
  mcp_read_user: { limit: 600, periodSec: 3600 },
  // Weighted evidence allowance: reserve up to 16 units per visual call.
  mcp_evidence_user: { limit: 240, periodSec: 3600 },
  mcp_write_user: { limit: 120, periodSec: 3600 },
} as const;

export type ThrottleScope = keyof typeof THROTTLE_RATES;

export type ThrottleCheck = {
  scope: ThrottleScope;
  /** キャッシュキーの ident 部分（user id / IP / email 等）。空ならスキップ。 */
  ident: string | null | undefined;
  /** 1 リクエストで消費する枠数。省略時は 1。 */
  cost?: number;
};


export function throttleConsumption(check: ThrottleCheck) {
  if (check.ident === null || check.ident === undefined || check.ident === '') return null;
  const rate = THROTTLE_RATES[check.scope];
  return { key: `throttle_${check.scope}_${check.ident}`, limit: rate.limit, windowSec: rate.periodSec, cost: Math.max(1, Math.trunc(check.cost ?? 1)) };
}
export function chatThrottlePolicy(userId: string | null | undefined, shared: boolean, publicDemo: boolean, ip: string): ThrottleCheck[] {
  return [ { scope: 'chat_authenticated', ident: userId },
    { scope: 'chat_share_token_ip', ident: shared ? ip : null }, { scope: 'chat_public_demo_ip', ident: publicDemo ? ip : null } ];
}
