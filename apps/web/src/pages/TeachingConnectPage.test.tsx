import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import TeachingConnectPage from './TeachingConnectPage';
type Fixture = { user: { id: string; email: string } | null; navigate: ReturnType<typeof vi.fn> };
const fixture = vi.hoisted<Fixture>(() => ({ user: { id: 'alice', email: 'alice@school.example' }, navigate: vi.fn() }));
vi.mock('@/lib/authSession', () => ({ useAuthSession: () => ({ data: { user: fixture.user }, isPending: false }) }));
vi.mock('@/lib/i18n', () => ({ useI18nNavigate: () => fixture.navigate }));
vi.mock('react-router-dom', () => ({ useLocation: () => ({ pathname: '/ja/teaching/connect', search: '?ticket=' + 'a'.repeat(64) }) }));
function mount() { return render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><TeachingConnectPage /></QueryClientProvider>); }
const review = { provider: 'classroom', title: 'Math', teacherName: 'Teacher A', contextId: 'class-a', courses: [{ id: 12, name: 'Basic' }, { id: 13, name: 'Advanced' }] };
beforeEach(() => { fixture.user = { id: 'alice', email: 'alice@school.example' };vi.clearAllMocks(); });
afterEach(() => { cleanup();vi.unstubAllGlobals(); });
it('requires independent VideoQ login before retrieving a connection request', () => {
  fixture.user = null;const fetch = vi.fn();vi.stubGlobal('fetch', fetch);mount();
  fireEvent.click(screen.getByRole('button', { name: 'VideoQにログイン' }));
  expect(fetch).not.toHaveBeenCalled();expect(fixture.navigate).toHaveBeenCalledWith(expect.stringContaining('/login?next='));
});
it.each(['classroom', 'moodle'])('connects only the selected owned course for %s', async provider => {
  const fetch = vi.fn().mockResolvedValueOnce(Response.json({ ...review, provider })).mockResolvedValueOnce(Response.json({ courseId: 13 }));vi.stubGlobal('fetch', fetch);mount();
  fireEvent.change(await screen.findByRole('combobox'), { target: { value: '13' } });
  expect(screen.getByText(/alice@school.example/)).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'このアカウントで接続' }));
  await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('接続しました。'));
  expect(JSON.parse(fetch.mock.calls[1][1].body)).toEqual({ ticket: 'a'.repeat(64), courseId: 13 });
});
it('shows a connection conflict without claiming success or overwriting another teacher', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(Response.json(review)).mockResolvedValueOnce(Response.json({}, { status: 409 })));mount();
  await screen.findByRole('combobox');fireEvent.click(screen.getByRole('button', { name: 'このアカウントで接続' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('このクラスはすでに接続されています。');
  expect(screen.queryByText(/接続しました/)).not.toBeInTheDocument();
});
