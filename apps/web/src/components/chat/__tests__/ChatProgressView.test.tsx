import { plainChatAnswer } from "@videoq/trpc/chat";
import { fireEvent, render, screen, within } from '@testing-library/react';
import { ChatMessageBubble } from '../ChatMessageBubble';
import type { Message } from '@/hooks/useChatMessages';
import { ChatProgressView } from '../ChatProgressView';

describe('chat activity display', () => {
  it.each(['thinking', 'summarizing', 'reviewing', 'answering'] as const)('shows the %s phase without opening details', phase => {
    render(<ChatProgressView progress={{ phase, searches: [], tools: [] }} waitingForAnswer />);
    expect(screen.getByRole('status')).toHaveTextContent(`chat.progress.${phase}`);
    expect(screen.getByText(`chat.progress.${phase}`, { selector: 'span' })).toBeVisible();
  });

  it('shows the active visual tool without opening details and retains its status after the answer', () => {
    const progress = { phase: 'searching', searches: [], tools: [
      { id: 1, tool: 'get_course_info', status: 'complete' },
      { id: 2, tool: 'focus_clip', status: 'running' },
    ] } as const;
    const { rerender } = render(<ChatProgressView progress={{ ...progress, searches: [], tools: [...progress.tools] }} waitingForAnswer />);
    expect(screen.getByRole('status')).toHaveTextContent('chat.progress.tools.focus_clip.running');
    expect(screen.getByText('chat.progress.tools.focus_clip.running', { selector: 'span' })).toBeVisible();
    expect(screen.getByRole('status')).not.toHaveTextContent('chat.progress.preparing');
    fireEvent.click(screen.getByRole('button'));
    expect(screen.getAllByRole('listitem')).toHaveLength(2);
    expect(screen.getByText('chat.progress.tools.focus_clip.name')).toBeVisible();
    expect(screen.queryByText('focus_clip', { selector: 'code' })).not.toBeInTheDocument();
    expect(screen.getByText('chat.progress.toolStatus.running')).toBeVisible();

    const finished = { ...progress, searches: [], tools: progress.tools.map(tool => ({ ...tool, status: 'complete' as const })) };
    rerender(<ChatProgressView progress={{ ...finished, phase: 'reviewing' }} waitingForAnswer />);
    expect(screen.getByRole('status')).toHaveTextContent('chat.progress.reviewing');
    rerender(<ChatProgressView progress={{ ...finished, phase: 'complete' }} waitingForAnswer={false} />);
    expect(screen.getByRole('status')).toHaveTextContent('chat.progress.usedTools');
    expect(screen.getAllByText('chat.progress.toolStatus.complete')).toHaveLength(2);
  });

  it.each([false, true])('keeps the waiting label until queued answer text is visible (searched: %s)', (searched) => {
    const props = { isFeedbackUpdating: false, onFeedback: vi.fn(), onVideoNavigate: vi.fn() };
    const message: Message = {
      role: 'assistant', answer: { segments: [{ text: '', sourceIds: [] }], sources: [] }, progress: {
        phase: searched ? 'reviewing' : 'preparing',
        searches: searched ? [{ id: 1, query: 'ドモルガンの定理', status: 'complete' }] : [],
      },
    };
    const { rerender } = render(<ChatMessageBubble {...props} message={message} isAwaitingResponse />);
    expect(screen.getByRole('status')).toHaveTextContent(searched ? 'chat.progress.reviewing' : 'chat.progress.preparing');

    // The network has finished, but the typewriter has not painted the answer.
    const receivedMessage: Message = { ...message, progress: { ...message.progress!, phase: 'complete' } };
    rerender(<ChatMessageBubble {...props} message={receivedMessage} isAwaitingResponse />);
    expect(screen.getByRole('status')).toHaveTextContent('chat.progress.answering');

    rerender(<ChatMessageBubble {...props} message={{ ...receivedMessage, answer: plainChatAnswer('回答') }} isAwaitingResponse />);
    expect(screen.getByText('回答')).toBeVisible();
    if (searched) {
      expect(screen.getByRole('status')).toHaveTextContent('chat.progress.searched');
    } else {
      expect(screen.queryByRole('status')).not.toBeInTheDocument();
    }
  });

  it('shows a compact status and reveals only the searched topics on demand', () => {
    const props = { isFeedbackUpdating: false, onFeedback: vi.fn(), onVideoNavigate: vi.fn() };
    const message: Message = {
      role: 'assistant', answer: { segments: [{ text: '', sourceIds: [] }], sources: [] }, progress: { phase: 'searching', searches: [
        { id: 1, query: '回路を簡単にする', status: 'complete' },
        { id: 2, query: 'ドモルガンの定理', status: 'running' },
      ] },
    };
    const { rerender } = render(<ChatMessageBubble {...props} message={message} isAwaitingResponse />);
    expect(screen.getByText('ドモルガンの定理')).not.toBeVisible();
    expect(screen.getByRole('status')).toHaveTextContent('chat.progress.checkingVideos');
    expect(screen.queryByRole('list')).not.toBeInTheDocument();

    rerender(<ChatMessageBubble {...props} message={{
      ...message, progress: {
        phase: 'reviewing', searches: message.progress!.searches.map((search) => ({ ...search, status: 'complete' })),
      },
    }} isAwaitingResponse />);
    expect(screen.getByRole('status')).toHaveTextContent('chat.progress.reviewing');
    expect(screen.getByText('ドモルガンの定理')).not.toBeVisible();

    rerender(<ChatMessageBubble {...props} message={message} isAwaitingResponse />);
    expect(screen.getByRole('status')).toHaveTextContent('chat.progress.checkingVideos');

    rerender(<ChatMessageBubble {...props} message={{
      ...message, answer: plainChatAnswer('定理を使って簡単にできます。'), progress: {
        phase: 'complete', searches: [
          ...message.progress!.searches.map((search) => ({ ...search, status: 'complete' as const })),
          { id: 3, query: 'ドモルガンの定理', status: 'complete' },
        ],
      },
    }} />);
    expect(screen.getByText('定理を使って簡単にできます。')).toBeVisible();
    const toggle = screen.getByRole('button', { name: /chat.progress.details/ });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getAllByRole('listitem')).toHaveLength(2);
    expect(screen.getAllByRole('listitem').map((item) => item.textContent)).toEqual([
      '回路を簡単にする', 'ドモルガンの定理',
    ]);
    expect(within(screen.getByRole('list')).getByText('回路を簡単にする')).toBeVisible();
    expect(within(screen.getByRole('list')).getByText('ドモルガンの定理')).toBeVisible();
  });
});
