import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { QaQuestion, QaReply } from '@videoq/trpc';
import { CourseQaPanel } from '../CourseQaPanel';
import { CourseLearningDetails } from '../../CourseLearningDetails';

const question: QaQuestion = {
  id: '11111111-1111-4111-8111-111111111111', title: 'Rotation order', body: 'Why does order matter?',
  videoId: 7, videoTitle: 'Matrices', author: { name: 'Alice', instructor: false },
  createdAt: '2026-11-01T09:00:00Z', updatedAt: '2026-11-01T09:00:00Z', featured: true,
  replyCount: 1, votes: 3, voted: false, canEdit: true, canDelete: true,
};
const answer: QaReply = {
  id: '22222222-2222-4222-8222-222222222222', body: 'Try composing two transformations.',
  author: { name: 'Instructor', instructor: true }, createdAt: question.createdAt, updatedAt: question.updatedAt,
  canEdit: true, canDelete: true,
};
const list = vi.fn();
const get = vi.fn();
const mutations = Object.fromEntries(['ask', 'reply', 'updateQuestion', 'deleteQuestion', 'updateReply', 'deleteReply', 'vote', 'feature'].map(name => [name, vi.fn()]));
const play = vi.fn();
const props = { courseId: 5, videoId: 7, videoTitle: 'Matrices', active: true, onVideoPlay: play };
const change = (label: string, value: string) => fireEvent.change(screen.getByLabelText(`qa.${label}`), { target: { value } });
const click = (name: string) => fireEvent.click(screen.getByRole('button', { name }));
const open = async () => fireEvent.click(await screen.findByRole('button', { name: question.title }));

beforeEach(() => {
  vi.clearAllMocks();
  list.mockResolvedValue({ items: [question], total: 1, canPost: true, canModerate: true });
  get.mockResolvedValue({ question, replies: [answer], replyTotal: 1, canPost: true, canModerate: true });
  globalThis.__setTrpcHandler('qa.list', list);
  globalThis.__setTrpcHandler('qa.get', get);
  for (const [name, handler] of Object.entries(mutations)) {
    handler.mockResolvedValue(name === 'ask' || name === 'reply' ? { id: question.id } : { success: true });
    globalThis.__setTrpcHandler(`qa.${name}`, handler);
  }
});

it('keeps Q&A lazy, preserves drafts across learning tabs and shows an empty overview', async () => {
  render(<CourseLearningDetails {...props} />);
  expect(screen.getByText('qa.noOverview')).toBeVisible();
  expect(list).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('tab', { name: 'videos.shared.tabs.qa' }));
  await screen.findByRole('button', { name: 'qa.ask' });
  click('qa.ask'); change('questionTitle', 'Draft'); change('questionBody', 'Keep this text');
  fireEvent.click(screen.getByRole('tab', { name: 'videos.shared.tabs.overview' }));
  fireEvent.click(screen.getByRole('tab', { name: 'videos.shared.tabs.qa' }));
  expect(screen.getByLabelText('qa.questionBody')).toHaveValue('Keep this text');
  click('common.actions.cancel');
  expect(await screen.findByRole('button', { name: question.title })).toBeVisible();
});

it('publishes a lecture question, opens it and submits an answer with course access', async () => {
  render(<CourseQaPanel {...props} shareSlug="shared-course" />);
  await screen.findByRole('button', { name: 'qa.ask' });
  click('qa.ask'); change('questionTitle', 'New question'); change('questionBody', 'Question details'); click('qa.publish');
  await screen.findByRole('heading', { name: question.title });
  expect(mutations.ask).toHaveBeenCalledWith(expect.objectContaining({ courseId: 5, shareSlug: 'shared-course', videoId: 7, title: 'New question', body: 'Question details' }));
  change('yourAnswer', 'A useful answer'); click('qa.postAnswer');
  await waitFor(() => expect(mutations.reply).toHaveBeenCalledWith(expect.objectContaining({ questionId: question.id, body: 'A useful answer' })));
  await waitFor(() => expect(screen.getByLabelText('qa.yourAnswer')).toHaveValue(''));
  click('Matrices'); expect(play).toHaveBeenCalledWith(7, '00:00:00');
  click('qa.back'); expect(await screen.findByRole('button', { name: question.title })).toBeVisible();
});

it('preserves input on posting failure and allows a successful retry', async () => {
  mutations.ask.mockRejectedValueOnce(new Error('Offline'));
  render(<CourseQaPanel {...props} />);
  await screen.findByRole('button', { name: 'qa.ask' }); click('qa.ask');
  change('questionTitle', 'Retry question'); change('questionBody', 'Keep my question'); click('qa.publish');
  expect(await screen.findByRole('alert')).toHaveTextContent('qa.operationError');
  expect(screen.getByLabelText('qa.questionBody')).toHaveValue('Keep my question');
  click('qa.publish'); await screen.findByRole('heading', { name: question.title });
  expect(mutations.ask).toHaveBeenCalledTimes(2);
});

it('edits questions and answers, cancels editing and toggles votes and featured state', async () => {
  render(<CourseQaPanel {...props} />); await open();
  await screen.findByText(answer.body);
  click('common.actions.edit'); change('questionTitle', 'Edited title'); change('questionBody', 'Edited question'); click('qa.publish');
  await waitFor(() => expect(mutations.updateQuestion).toHaveBeenCalledWith(expect.objectContaining({ title: 'Edited title', body: 'Edited question' })));
  await screen.findByText(answer.body);
  click('common.actions.edit'); click('common.actions.cancel');
  click('qa.editAnswer');
  const editor = within(screen.getByRole('article'));
  fireEvent.change(editor.getByLabelText('qa.yourAnswer'), { target: { value: 'Edited answer' } });
  fireEvent.click(editor.getByRole('button', { name: 'qa.postAnswer' }));
  await waitFor(() => expect(mutations.updateReply).toHaveBeenCalledWith(expect.objectContaining({ replyId: answer.id, body: 'Edited answer' })));
  await screen.findByText(answer.body);
  click('qa.editAnswer'); click('common.actions.cancel');
  click('qa.vote'); await waitFor(() => expect(mutations.vote).toHaveBeenCalledWith(expect.objectContaining({ voted: true })));
  await waitFor(() => expect(screen.getByRole('button', { name: 'qa.unfeature' })).toBeEnabled());
  click('qa.unfeature'); await waitFor(() => expect(mutations.feature).toHaveBeenCalledWith(expect.objectContaining({ featured: false })));
});

it('requires confirmation for deleting replies and questions', async () => {
  render(<CourseQaPanel {...props} />); await open(); await screen.findByText(answer.body);
  click('qa.deleteAnswer');
  const first = await screen.findByRole('dialog');
  fireEvent.click(within(first).getByRole('button', { name: 'common.actions.cancel' }));
  expect(mutations.deleteReply).not.toHaveBeenCalled();
  click('qa.deleteAnswer');
  fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'common.actions.delete' }));
  await waitFor(() => expect(mutations.deleteReply).toHaveBeenCalledWith(expect.objectContaining({ replyId: answer.id })));
  await waitFor(() => expect(screen.getByRole('button', { name: 'qa.deleteQuestion' })).toBeEnabled());
  click('qa.deleteQuestion');
  fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'common.actions.delete' }));
  await waitFor(() => expect(mutations.deleteQuestion).toHaveBeenCalledWith(expect.objectContaining({ questionId: question.id })));
  expect(await screen.findByRole('button', { name: question.title })).toBeVisible();
});

it('searches, filters by lecture and unanswered state and pages through results', async () => {
  list.mockResolvedValue({ items: [question], total: 41, canPost: true, canModerate: false });
  render(<CourseQaPanel {...props} />); await screen.findByRole('button', { name: question.title });
  change('search', 'rotation'); click('qa.searchButton');
  await waitFor(() => expect(list).toHaveBeenLastCalledWith(expect.objectContaining({ search: 'rotation', offset: 0 })));
  fireEvent.click(screen.getByRole('checkbox', { name: 'qa.currentLecture' }));
  fireEvent.click(screen.getByRole('checkbox', { name: 'qa.unanswered' }));
  await waitFor(() => expect(list).toHaveBeenLastCalledWith(expect.objectContaining({ videoId: 7, unanswered: true })));
  await waitFor(() => expect(screen.getByRole('button', { name: 'qa.next' })).toBeEnabled()); click('qa.next');
  await waitFor(() => expect(list).toHaveBeenLastCalledWith(expect.objectContaining({ offset: 20 })));
  await waitFor(() => expect(screen.getByRole('button', { name: 'qa.previous' })).toBeEnabled()); click('qa.previous');
  await waitFor(() => expect(list).toHaveBeenLastCalledWith(expect.objectContaining({ offset: 0 })));
});

it('allows shared-link reading without exposing author or moderation controls', async () => {
  globalThis.__setMockAuthSession(null);
  list.mockResolvedValue({ items: [{ ...question, author: { name: null, instructor: false }, canEdit: false, canDelete: false }], total: 1, canPost: false, canModerate: false });
  get.mockResolvedValue({ question: { ...question, canEdit: false, canDelete: false }, replies: [], replyTotal: 0, canPost: false, canModerate: false });
  render(<CourseQaPanel {...props} shareSlug="shared-course" />);
  await screen.findByRole('link', { name: 'qa.loginToPost' });
  expect(screen.getByText('qa.deletedUser')).toBeVisible();
  expect(screen.queryByRole('button', { name: 'qa.ask' })).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'qa.vote' })).toBeDisabled();
  await open(); await screen.findByText('qa.noAnswers');
  expect(screen.queryByRole('button', { name: 'qa.deleteQuestion' })).not.toBeInTheDocument();
  expect(screen.queryByLabelText('qa.yourAnswer')).not.toBeInTheDocument();
});

it('shows load errors with retry and distinguishes empty search results', async () => {
  list.mockRejectedValueOnce(new Error('Unavailable'));
  render(<CourseQaPanel {...props} />);
  await screen.findByText('qa.loadError'); click('chat.retry'); await open();
  await screen.findByText(answer.body); click('qa.back');
  list.mockResolvedValue({ items: [], total: 0, canPost: true, canModerate: false });
  change('search', 'missing'); click('qa.searchButton'); await screen.findByText('qa.noMatches');
  change('search', ''); click('qa.searchButton'); await screen.findByText('qa.empty');
});

it('separates posting from voting and labels Moodle course pseudonyms', async () => {
  list.mockResolvedValue({ items: [{ ...question, author: { name: 'a1b2c3d4e5f6', source: 'moodle', instructor: false } }],
    total: 1, canPost: true, canVote: false, canModerate: false });
  render(<CourseQaPanel {...props} />);
  expect(await screen.findByText(/^qa\.moodleParticipant /)).toHaveTextContent('a1b2c3d4e5f6');
  expect(screen.getByRole('button', { name: 'qa.ask' })).toBeEnabled();
  expect(screen.getByRole('button', { name: 'qa.vote' })).toBeDisabled();
});

it('pages answers, retries detail loading and preserves lecture context', async () => {
  get.mockRejectedValueOnce(new Error('Unavailable'));
  render(<CourseQaPanel {...props} />); await open();
  await screen.findByText('qa.loadError');
  get.mockResolvedValue({ question, replies: [answer], replyTotal: 41, canPost: true, canModerate: true });
  click('chat.retry'); await screen.findByText(answer.body);
  click('qa.next'); await waitFor(() => expect(get).toHaveBeenLastCalledWith(expect.objectContaining({ offset: 20 })));
  await waitFor(() => expect(screen.getByRole('button', { name: 'qa.previous' })).toBeEnabled()); click('qa.previous');
  await waitFor(() => expect(get).toHaveBeenLastCalledWith(expect.objectContaining({ offset: 0 })));
});

it('waits for authentication before querying and includes available overview content', () => {
  globalThis.__setMockAuthSession(null, true);
  render(<CourseLearningDetails {...props} courseDescription="Course description" />);
  expect(screen.getByText('Course description')).toBeVisible();
  expect(list).not.toHaveBeenCalled();
});
