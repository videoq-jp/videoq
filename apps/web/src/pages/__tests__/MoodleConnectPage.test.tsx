import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useAuthSession } from '@/lib/authSession';
import { useI18nNavigate } from '@/lib/i18n';
import { returnToMoodle } from '@/lib/moodleConnect';
import MoodleConnectPage from '../MoodleConnectPage';

vi.mock('@/lib/authSession', () => ({ useAuthSession: vi.fn() }));
vi.mock('@/lib/moodleConnect', async original => ({ ...await original<typeof import('@/lib/moodleConnect')>(), returnToMoodle: vi.fn() }));
const query = new URLSearchParams({ moodle_url: 'https://private.example:9443/academy', state: 'a'.repeat(64), code_challenge: 'b'.repeat(43) }).toString();

describe('Moodle connection approval', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    globalThis.__setMockPathname('/moodle/connect'); globalThis.__setMockSearchParams('?' + query);
    vi.mocked(useAuthSession).mockReturnValue({ isPending: false, error: null, data: { user: { id: 'owner', email: 'owner@example.invalid' } } } as ReturnType<typeof useAuthSession>);
  });
  afterEach(() => { globalThis.__setMockPathname('/'); globalThis.__setMockSearchParams(''); vi.unstubAllGlobals(); });

  it('requires explicit approval and sends the S256 challenge with session credentials', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ code: 'VIDEOQ2.' + btoa(JSON.stringify({ origin: 'https://api.example', secret: 'c'.repeat(64) })) })));
    vi.stubGlobal('fetch', fetcher);
    render(<MoodleConnectPage />);
    expect(screen.getByText('https://private.example:9443/academy')).toBeInTheDocument();
    expect(fetcher).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'auth.moodleConnect.allow' }));
    await waitFor(() => expect(returnToMoodle).toHaveBeenCalledTimes(1));
    const [endpoint, options] = fetcher.mock.calls[0];
    expect(endpoint).toMatch(/\/lms\/pairing$/);
    expect(options.credentials).toBe('include');
    expect(JSON.parse(options.body)).toEqual({ moodleUrl: 'https://private.example:9443/academy', codeChallenge: 'b'.repeat(43) });
    const callback = new URL(vi.mocked(returnToMoodle).mock.calls[0][0]);
    expect(callback.origin).toBe('https://private.example:9443');
    expect(callback.searchParams.get('code')).toBe('c'.repeat(64));
    expect(callback.searchParams.get('state')).toBe('a'.repeat(64));
  });

  it('preserves the entire request when asking an anonymous user to sign in', () => {
    vi.mocked(useAuthSession).mockReturnValue({ isPending: false, error: null, data: null } as ReturnType<typeof useAuthSession>);
    render(<MoodleConnectPage />);
    fireEvent.click(screen.getByRole('button', { name: 'auth.moodleConnect.login' }));
    expect(useI18nNavigate()).toHaveBeenCalledWith('/login?next=' + encodeURIComponent('/moodle/connect?' + query));
    expect(returnToMoodle).not.toHaveBeenCalled();
  });

  it('cancels without issuing a code', () => {
    const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher);
    render(<MoodleConnectPage />);
    fireEvent.click(screen.getByRole('button', { name: 'auth.moodleConnect.cancel' }));
    expect(fetcher).not.toHaveBeenCalled();
    const callback = new URL(vi.mocked(returnToMoodle).mock.calls[0][0]);
    expect(callback.searchParams.get('error')).toBe('access_denied');
    expect(callback.searchParams.has('code')).toBe(false);
  });

  it('does not redirect after a failed approval and permits retry', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}', { status: 500 })));
    render(<MoodleConnectPage />);
    fireEvent.click(screen.getByRole('button', { name: 'auth.moodleConnect.allow' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('auth.moodleConnect.error');
    expect(screen.getByRole('button', { name: 'auth.moodleConnect.allow' })).toBeEnabled();
    expect(returnToMoodle).not.toHaveBeenCalled();
  });

  it('does not offer approval or redirect for a malformed request', () => {
    globalThis.__setMockSearchParams('?moodle_url=https://evil.example');
    render(<MoodleConnectPage />);
    expect(screen.getByRole('alert')).toHaveTextContent('auth.moodleConnect.invalid');
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    expect(returnToMoodle).not.toHaveBeenCalled();
  });
});
