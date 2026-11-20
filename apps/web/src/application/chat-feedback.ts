export type ChatFeedbackValue = 'good' | 'bad' | null;

interface FeedbackMessage {
  chatLogId?: number;
  feedback?: ChatFeedbackValue;
}

export function getNextChatFeedback(
  currentFeedback: ChatFeedbackValue | undefined,
  selectedFeedback: Exclude<ChatFeedbackValue, null>,
): ChatFeedbackValue {
  return currentFeedback === selectedFeedback ? null : selectedFeedback;
}

export function applyChatFeedback<T extends FeedbackMessage>(
  messages: T[],
  chatLogId: number,
  feedback: ChatFeedbackValue,
): T[] {
  return messages.map((message) =>
    message.chatLogId === chatLogId
      ? { ...message, feedback }
      : message,
  );
}

interface IssuedFeedbackMessage extends FeedbackMessage {
  feedbackToken?: string;
}

export interface FeedbackSubmission {
  chatLogId: number;
  feedback: ChatFeedbackValue;
  shareSlug?: string;
  feedbackToken?: string;
}

export interface FeedbackDependencies<Result extends { feedback: ChatFeedbackValue }> {
  pending: Set<number>;
  pendingChanged(): void;
  send(input: FeedbackSubmission): Promise<Result>;
  apply(chatLogId: number, result: Result): void;
  refresh(courseId: number, result: Result): Promise<void>;
  failed(error: unknown): void;
}

/** Admit issued answers, serialize per-answer writes and apply only saved feedback. */
export async function submitChatFeedback<Result extends { feedback: ChatFeedbackValue }>(
  input: {
    chatLogId: number;
    selected: Exclude<ChatFeedbackValue, null>;
    messages: readonly IssuedFeedbackMessage[];
    shareToken?: string;
    courseId?: number;
  },
  deps: FeedbackDependencies<Result>,
): Promise<void> {
  const { chatLogId, shareToken, courseId } = input;
  if (deps.pending.has(chatLogId)) return;
  const target = input.messages.find(message => message.chatLogId === chatLogId);
  if (!target || (shareToken && !target.feedbackToken)) return;
  const feedback = getNextChatFeedback(target.feedback, input.selected);
  deps.pending.add(chatLogId);
  deps.pendingChanged();
  try {
    const result = await deps.send({
      chatLogId, feedback, shareSlug: shareToken,
      feedbackToken: shareToken ? target.feedbackToken : undefined,
    });
    deps.apply(chatLogId, result);
    if (courseId && !shareToken) await deps.refresh(courseId, result);
  } catch (error) {
    deps.failed(error);
  } finally {
    deps.pending.delete(chatLogId);
    deps.pendingChanged();
  }
}
