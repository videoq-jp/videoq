import type { RefObject } from 'react';
import type { Message } from '@/hooks/useChatMessages';
import { ChatMessageBubble } from '@/components/chat/ChatMessageBubble';

interface ChatMessagesViewProps {
  messages: Message[];
  isLoading: boolean;
  feedbackUpdatingIds: ReadonlySet<number>;
  messagesContainerRef: RefObject<HTMLDivElement | null>;
  messagesEndRef?: RefObject<HTMLDivElement | null>;
  onScroll?: () => void;
  onVideoNavigate: (videoId: number, startTime: string) => void;
  onFeedback: (chatLogId: number, value: 'good' | 'bad') => Promise<unknown>;
}

export function ChatMessagesView({
  messages,
  isLoading,
  feedbackUpdatingIds,
  messagesContainerRef,
  messagesEndRef,
  onScroll,
  onVideoNavigate,
  onFeedback,
}: ChatMessagesViewProps) {
  return (
    <div ref={messagesContainerRef} onScroll={onScroll} className="min-h-0 flex-1 overflow-y-auto p-3 sm:p-4 space-y-4 [overflow-anchor:none] [scrollbar-gutter:stable]">
      {messages.map((message, index) => (
        <ChatMessageBubble
          key={index}
          message={message}
          // Only the trailing bubble can be the one the stream is filling in.
          isAwaitingResponse={isLoading && index === messages.length - 1}
          isFeedbackUpdating={message.chatLogId !== undefined && feedbackUpdatingIds.has(message.chatLogId)}
          onVideoNavigate={onVideoNavigate}
          onFeedback={onFeedback}
        />
      ))}
      <div ref={messagesEndRef} />
    </div>
  );
}
