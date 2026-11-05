export type LtiLocale = "ja" | "en";

/** LMS regional tags (including Moodle underscores) map to supported languages. */
export function resolveLtiLocale(value: unknown, fallback: LtiLocale = "en"): LtiLocale {
  if (typeof value !== "string") return fallback;
  for (const item of value.split(",")) {
    const [tag, ...parameters] = item.trim().split(";");
    if (parameters.some(parameter => /^\s*q=0(?:\.0*)?\s*$/.test(parameter))) continue;
    const language = tag.toLowerCase().split(/[-_]/)[0];
    if (language === "ja" || language === "en") return language;
  }
  return fallback;
}

export function launchLocale(payload: Record<string, unknown>, fallback: LtiLocale = "en"): LtiLocale {
  const presentation = payload["https://purl.imsglobal.org/spec/lti/claim/launch_presentation"];
  const locale = presentation && typeof presentation === "object" ? (presentation as Record<string, unknown>).locale : undefined;
  return resolveLtiLocale(locale, fallback);
}

export const ltiCopy = {
  ja: {
    connectTitle: "VideoQ 接続",
    connecting: "学習システムに接続しています…",
    storageError: "接続情報を保存できません。LMSから別ウィンドウで開いてください。",
    title: "VideoQ 教材に質問",
    chat: "教材チャット",
    heading: "講座に質問",
    conversation: "会話",
    emptyTitle: "この講座について聞いてみましょう",
    emptyBody: "講座内の動画をまとめて質問できます。",
    checking: "接続を確認しています…",
    label: "教材について聞きたいこと",
    placeholder: "教材について質問する…",
    send: "質問する",
    hint: "Enterで送信・Shift＋Enterで改行。AIの回答は教材とあわせて確認してください。",
    you: "あなた",
    assistant: "AIアシスタント",
    feedbackError: "評価を保存できませんでした。もう一度お試しください。",
    interrupted: "回答の受信が中断されました。もう一度お試しください。",
    seek: "へ移動",
    playbackError: "動画の接続と再生位置を確認してください。",
    missing: "接続情報がありません。LMSの教材リンクから開き直してください。",
    connectionError: "接続できません。教材の連携設定を確認し、LMSから開き直してください。",
    answering: "教材を確認して回答しています…",
    expired: "接続の有効期限が切れました。LMSから開き直してください。",
    rateLimit: "質問が集中しています。少し待って再試行してください。",
    answerError: "回答を取得できませんでした。時間をおいて再試行してください。",
  },
  en: {
    connectTitle: "VideoQ connection",
    connecting: "Connecting to your LMS…",
    storageError: "Unable to save connection details. Open this tool in a separate window from your LMS.",
    title: "VideoQ lesson questions",
    chat: "Lesson chat",
    heading: "Ask about this course",
    conversation: "Conversation",
    emptyTitle: "Ask about this course",
    emptyBody: "Ask questions across the videos in this course.",
    checking: "Checking your connection…",
    label: "Your question about the lesson",
    placeholder: "Ask about the lesson…",
    send: "Ask a question",
    hint: "Enter to send · Shift+Enter for a new line. Check AI answers against the lesson.",
    you: "You",
    assistant: "AI Assistant",
    feedbackError: "Unable to save feedback. Please try again.",
    interrupted: "The answer was interrupted. Please try again.",
    seek: " — jump to this point",
    playbackError: "Check the video connection and playback position.",
    missing: "Connection details are missing. Reopen this tool from the lesson link in your LMS.",
    connectionError: "Unable to connect. Check the lesson integration settings and reopen from your LMS.",
    answering: "Checking the lesson and preparing an answer…",
    expired: "Your session has expired. Reopen this tool from your LMS.",
    rateLimit: "Too many questions. Please wait a moment and try again.",
    answerError: "Unable to get an answer. Please try again later.",
  },
};
