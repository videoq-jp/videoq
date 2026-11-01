import { chatAnswerText } from '@videoq/trpc/chat';
import { BookOpen, ThumbsDown, ThumbsUp } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { Message } from '@/hooks/useChatMessages';
import { MessageBody } from '@/components/chat/MessageBody';
import { TypingIndicator } from '@/components/chat/TypingIndicator';
import { ChatProgressView } from '@/components/chat/ChatProgressView';
import { Button } from '@/components/ui/button';

interface ChatMessageBubbleProps {
  message: Message;
  /** True while this bubble is the one waiting on the in-flight response. */
  isAwaitingResponse?: boolean;
  isFeedbackUpdating: boolean;
  onVideoNavigate: (videoId: number, startTime: string) => void;
  onFeedback: (chatLogId: number, value: 'good' | 'bad') => Promise<unknown>;
}

export function ChatMessageBubble({
  message,
  isAwaitingResponse = false,
  isFeedbackUpdating,
  onVideoNavigate,
  onFeedback,
}: ChatMessageBubbleProps) {
  const { t } = useTranslation();

  if (message.role === 'user') {
    return (
      <div className="flex flex-col items-end gap-1">
        <div className="max-w-[90%] border border-solid-gray-420 bg-solid-gray-50 px-4 py-3 text-std-16N-170 text-solid-gray-800">
          {message.content}
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col items-start gap-1">
      <div className="w-[90%] space-y-2 border border-solid-gray-420 border-l-4 border-l-key-900 bg-white p-4 text-std-16N-170">
        <div className="mb-1 flex items-center gap-2 text-dns-14B-120 font-bold text-key-900">
          <BookOpen className="h-3.5 w-3.5" />
          {t('chat.answerLabel')}
        </div>
        {message.progress && (
          <ChatProgressView
            progress={message.progress}
            waitingForAnswer={isAwaitingResponse && chatAnswerText(message.answer).trim() === ''}
          />
        )}
        {isAwaitingResponse && chatAnswerText(message.answer) === '' && !message.progress ? (
          <TypingIndicator />
        ) : (
          <MessageBody
            answer={message.answer}
            onVideoNavigate={onVideoNavigate}
          />
        )}
        {message.chatLogId && (
          <div className="flex gap-2 pt-2">
            <Button
              type="button"
              variant="text"
              size="xs"
              disabled={isFeedbackUpdating}
              onClick={() => { void onFeedback(message.chatLogId!, 'good'); }}
              className={`min-w-0 p-1 ${
                message.feedback === 'good' ? 'text-key-900' : 'text-solid-gray-420'
              }`}
              aria-label={t('chat.feedbackGood')}
              aria-pressed={message.feedback === 'good'}
            >
              <ThumbsUp className="h-4 w-4" />
            </Button>
            <Button
              type="button"
              variant="text"
              size="xs"
              disabled={isFeedbackUpdating}
              onClick={() => { void onFeedback(message.chatLogId!, 'bad'); }}
              className={`min-w-0 p-1 ${
                message.feedback === 'bad' ? 'text-error-1' : 'text-solid-gray-420'
              }`}
              aria-label={t('chat.feedbackBad')}
              aria-pressed={message.feedback === 'bad'}
            >
              <ThumbsDown className="h-4 w-4" />
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
