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
    qa: {
      title: "講座のQ&A", shared: "投稿した質問と返信は、この講座のQ&Aを閲覧できる利用者に共有されます。",
      loading: "Q&Aを読み込んでいます…", error: "Q&Aを取得できません。権限と接続を確認し、もう一度お試しください。",
      search: "質問を検索", lesson: "教材", allLessons: "すべての教材", wholeCourse: "講座全体", unavailableLesson: "選択した教材を閲覧できません。教材を選び直してください。",
      unanswered: "返信のない質問", sort: "並び順", recent: "新しい順", votes: "投票", apply: "検索する", refresh: "更新",
      ask: "質問を投稿", questionTitle: "質問のタイトル", questionBody: "質問の内容", publish: "投稿する", reply: "返信する", replyBody: "返信の内容", postReply: "返信を投稿",
      edit: "編集", delete: "削除", save: "保存", cancel: "キャンセル", back: "質問一覧に戻る", previous: "前へ", next: "次へ", replies: "返信", empty: "質問はまだありません。", noReplies: "返信はまだありません。",
      feature: "注目に指定", unfeature: "注目を解除", featured: "注目", vote: "投票する", removeVote: "投票を取り消す",
      participant: "参加者", instructor: "教師", deletedUser: "削除済み利用者", readOnly: "現在は閲覧のみ可能です。入力した文章をコピーできます。",
      confirmTitle: "操作の確認", discardAction: "変更を破棄", discard: "投稿・保存していない変更を破棄しますか？", deleteQuestion: "この質問を削除しますか？返信もすべて削除されます。", deleteReply: "この返信を削除しますか？",
    },
    transcript: "教材の文字起こし",
    material: "教材",
    refreshMaterials: "教材一覧を更新",
    moreTranscript: "続きを表示",
    emptyTranscript: "文字起こしはまだありません。",
    materialError: "教材を取得できません。権限と接続を確認し、教材一覧を更新してください。",
    materialPreparing: "教材を処理中です。準備ができるまで質問は利用できません。教材管理から状況を確認できます。",
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
    qa: {
      title: "Course Q&A", shared: "Questions and replies are shared with people who can view this course's Q&A.",
      loading: "Loading course Q&A…", error: "Unable to load Q&A. Check your access and connection, then try again.",
      search: "Search questions", lesson: "Lesson", allLessons: "All lessons", wholeCourse: "Entire course", unavailableLesson: "This lesson is no longer accessible. Choose a lesson again.",
      unanswered: "Unanswered questions", sort: "Sort order", recent: "Most recent", votes: "Votes", apply: "Search", refresh: "Refresh",
      ask: "Ask the course", questionTitle: "Question title", questionBody: "Question details", publish: "Publish question", reply: "Reply", replyBody: "Reply details", postReply: "Post reply",
      edit: "Edit", delete: "Delete", save: "Save", cancel: "Cancel", back: "Back to questions", previous: "Previous", next: "Next", replies: "Replies", empty: "No questions yet.", noReplies: "No replies yet.",
      feature: "Feature question", unfeature: "Unfeature question", featured: "Featured", vote: "Vote", removeVote: "Remove vote",
      participant: "Participant", instructor: "Instructor", deletedUser: "Deleted user", readOnly: "Posting is currently unavailable. You can copy your draft text.",
      confirmTitle: "Confirm action", discardAction: "Discard changes", discard: "Discard your unpublished changes?", deleteQuestion: "Delete this question and all of its replies?", deleteReply: "Delete this reply?",
    },
    transcript: "Lesson transcripts",
    material: "Lesson",
    refreshMaterials: "Refresh lessons",
    moreTranscript: "Show more",
    emptyTranscript: "No transcript is available yet.",
    materialError: "Unable to load this lesson. Check your access and connection, then refresh the lesson list.",
    materialPreparing: "Materials are processing. Questions become available when a material is ready. Check progress in material management.",
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
