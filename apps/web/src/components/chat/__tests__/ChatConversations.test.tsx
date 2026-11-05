import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { plainChatAnswer } from '@videoq/trpc/chat';
import { ChatPanel } from '../ChatPanel';
import { apiClient } from '@/lib/api';

vi.mock('@/lib/api', async importOriginal => ({ ...await importOriginal<typeof import('@/lib/api')>(),
  apiClient: { chatStream: vi.fn(), exportChatHistoryCsv: vi.fn() },
}));
const storageKey = (actor = '1', shareToken?: string) => `videoq:conversations:${shareToken ? 'v2' : 'v1'}:${JSON.stringify([actor, 5, shareToken])}`;
const id = '82ea775b-4b54-4a41-b16e-21fa3670ac11';
const saved = (conversationId = id, title = 'Inner product') => ({
  id: conversationId, title, createdAt: '2026-11-01T00:00:00Z', updatedAt: '2026-11-02T00:00:00Z', isGenerating: false,
  turns: [{ id: '1', question: 'What is the inner product?', answer: plainChatAnswer('The inner product compares two vectors.'), chatLogId: null, feedback: null }],
  hasMore: false,
});
const mockDetail = vi.fn();
const mockList = vi.fn();
const mockDelete = vi.fn();
beforeEach(() => {
  localStorage.clear();
  vi.clearAllMocks();
  mockDetail.mockImplementation(() => saved());
  mockList.mockResolvedValue({ items: [], hasMore: false });
  mockDelete.mockResolvedValue({ success: true });
  globalThis.__setTrpcHandler('chat.conversation', mockDetail);
  globalThis.__setTrpcHandler('chat.conversations', mockList);
  globalThis.__setTrpcHandler('chat.deleteConversation', mockDelete);
  vi.mocked(apiClient.chatStream).mockImplementation(async function* () {
    yield { type: 'text_delta', segmentIndex: 0, text: 'A perpendicular-vector example.' };
    yield { type: 'done', chat_log_id: null, feedback: null };
  });
});
afterEach(() => localStorage.clear());

it('restores the original transcript after remount and continues the same conversation', async () => {
  const first = render(<ChatPanel courseId={5} />);
  fireEvent.change(screen.getByLabelText('chat.placeholder'), { target: { value: 'What is the inner product?' } });
  fireEvent.click(screen.getByRole('button', { name: 'common.actions.send' }));
  await screen.findByText('A perpendicular-vector example.');
  const firstId = vi.mocked(apiClient.chatStream).mock.calls[0][0].conversation_id;
  expect(localStorage.getItem(storageKey())).toContain(firstId);
  mockDetail.mockImplementation(input => saved(input.conversationId));
  first.unmount();
  render(<ChatPanel courseId={5} />);
  await screen.findByText('The inner product compares two vectors.');
  expect(screen.getByText('What is the inner product?')).toBeInTheDocument();
  fireEvent.change(screen.getByLabelText('chat.placeholder'), { target: { value: 'Give me an example' } });
  fireEvent.click(screen.getByRole('button', { name: 'common.actions.send' }));
  await waitFor(() => expect(apiClient.chatStream).toHaveBeenCalledTimes(2));
  expect(vi.mocked(apiClient.chatStream).mock.calls[1][0]).toMatchObject({
    conversation_id: firstId, resume_conversation: true, messages: [{ role: 'user', content: 'Give me an example' }],
  });
});

it('continues automatically without exposing conversation management', async () => {
  render(<ChatPanel courseId={5} />);
  expect(screen.queryByRole('button', { name: 'chat.newConsultation' })).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'chat.myConversations' })).not.toBeInTheDocument();
  fireEvent.change(screen.getByLabelText('chat.placeholder'), { target: { value: 'What is the inner product?' } });
  fireEvent.click(screen.getByRole('button', { name: 'common.actions.send' }));
  await screen.findByText('A perpendicular-vector example.');
  fireEvent.change(screen.getByLabelText('chat.placeholder'), { target: { value: 'Give me an example' } });
  fireEvent.click(screen.getByRole('button', { name: 'common.actions.send' }));
  await waitFor(() => expect(apiClient.chatStream).toHaveBeenCalledTimes(2));
  expect(vi.mocked(apiClient.chatStream).mock.calls[1][0].conversation_id).toBe(vi.mocked(apiClient.chatStream).mock.calls[0][0].conversation_id);
  expect(mockList).not.toHaveBeenCalled();
});

it('blocks sending when restore fails instead of silently forgetting context', async () => {
  localStorage.setItem(storageKey(), JSON.stringify({ selected: { id, restore: true }, knownIds: [id] }));
  mockDetail.mockRejectedValue(new Error('Conversation expired'));
  render(<ChatPanel courseId={5} />);
  await screen.findByText('chat.restoreConversationError');
  expect(screen.queryByLabelText('chat.placeholder')).not.toBeInTheDocument();
  expect(apiClient.chatStream).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'chat.continueChat' }));
  expect(screen.getByLabelText('chat.placeholder')).toBeInTheDocument();
});

it('isolates persisted selections across accounts and shared routes', async () => {
  localStorage.setItem(storageKey('different-account'), JSON.stringify({ selected: { id, restore: true }, knownIds: [id] }));
  localStorage.setItem(storageKey('1', 'different-link'), JSON.stringify({ selected: { id, restore: true }, knownIds: [id] }));
  render(<ChatPanel courseId={5} />);
  expect(screen.getByText('chat.assistantGreeting')).toBeInTheDocument();
  expect(mockDetail).not.toHaveBeenCalled();
});

it('starts a fresh shared conversation instead of claiming legacy browser history', () => {
  const legacyKey = `videoq:conversations:v1:${JSON.stringify(['1', 5, 'shared'])}`;
  localStorage.setItem(legacyKey, JSON.stringify({ selected: { id, restore: true }, knownIds: [id] }));
  render(<ChatPanel courseId={5} shareToken="shared" showTitle={false} />);
  expect(screen.getByText('chat.assistantGreeting')).toBeInTheDocument();
  expect(mockDetail).not.toHaveBeenCalled();
});

it('restores shared chat without showing a title or conversation controls', async () => {
  localStorage.setItem(storageKey('1', 'shared'), JSON.stringify({ selected: { id, restore: true }, knownIds: [id] }));
  render(<ChatPanel courseId={5} shareToken="shared" showTitle={false} />);
  await screen.findByText('The inner product compares two vectors.');
  expect(screen.queryByRole('heading', { name: 'chat.title' })).not.toBeInTheDocument();
  for (const name of ['chat.myConversations', 'chat.newConsultation', 'chat.currentConversation', 'chat.history']) {
    expect(screen.queryByRole('button', { name })).not.toBeInTheDocument();
  }
  expect(mockList).not.toHaveBeenCalled();
});

it.each([
  { courseId: 5, showHistory: false },
  { courseId: 5, shareToken: 'shared' },
  {},
])('shows only chat content to learners without conversation controls (%j)', props => {
  render(<ChatPanel {...props} showTitle={false} />);
  expect(screen.getByLabelText('chat.placeholder')).toBeVisible();
  for (const name of ['chat.myConversations', 'chat.newConsultation', 'chat.currentConversation', 'chat.history']) {
    expect(screen.queryByRole('button', { name })).not.toBeInTheDocument();
  }
  expect(mockList).not.toHaveBeenCalled();
});

it('disables follow-ups until a remotely running answer has finished', async () => {
  localStorage.setItem(storageKey(), JSON.stringify({ selected: { id, restore: true }, knownIds: [id] }));
  mockDetail.mockResolvedValue({ ...saved(), isGenerating: true });
  render(<ChatPanel courseId={5} />);
  await screen.findByText('chat.answerInProgress');
  expect(screen.getByLabelText('chat.placeholder')).toBeDisabled();
  mockDetail.mockResolvedValue({ ...saved(), turns: [...saved().turns,
    { id: '2', question: 'Explain that', answer: plainChatAnswer('The remotely completed answer.'), chatLogId: null, feedback: null }], isGenerating: false });
  await screen.findByText('The remotely completed answer.', {}, { timeout: 4000 });
  await waitFor(() => expect(screen.getByLabelText('chat.placeholder')).not.toBeDisabled());
});


it('loads earlier original turns in order while retaining the selected conversation', async () => {
  localStorage.setItem(storageKey(), JSON.stringify({ selected: { id, restore: true }, knownIds: [id] }));
  mockDetail.mockImplementation(input => ({ ...saved(), hasMore: !input.beforeTurnId,
    turns: [{ ...saved().turns[0], id: input.beforeTurnId ? '1' : '2',
      question: input.beforeTurnId ? 'An earlier original question' : 'A recent original question' }],
  }));
  render(<ChatPanel courseId={5} />);
  await screen.findByText('A recent original question');
  fireEvent.click(screen.getByRole('button', { name: 'chat.loadEarlierMessages' }));
  await screen.findByText('An earlier original question');
  expect(mockDetail).toHaveBeenCalledWith(expect.objectContaining({ conversationId: id, beforeTurnId: '2' }));
  expect(screen.getByText('A recent original question')).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'chat.loadEarlierMessages' })).not.toBeInTheDocument();
});
