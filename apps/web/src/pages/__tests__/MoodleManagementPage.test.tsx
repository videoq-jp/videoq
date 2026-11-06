import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useAuthSession } from '@/lib/authSession';
import { authClient } from '@/lib/auth-client';
import { useI18nNavigate } from '@/lib/i18n';
import MoodleManagementPage from '../MoodleManagementPage';

vi.mock('@/lib/authSession', () => ({ useAuthSession: vi.fn() }));
vi.mock('@/lib/auth-client', () => ({ authClient: { signOut: vi.fn() } }));
const deployment = vi.hoisted(() => ({ billing: true, youtube: true }));
vi.mock('@/lib/deployment', () => ({ features: deployment, isOnprem: false }));
const tuple = { issuer: 'https://moodle.example:9443/academy', clientId: 'client', deploymentId: '23' };
const query = '?' + new URLSearchParams(tuple).toString();
const context = (owned = true, systemAdmin = false) => ({ connection: { owned, active: owned ? true : null },
  permissions: { account: owned, billing: owned, systemAdmin } });
const signedIn = (id = 'owner') => ({ isPending: false, error: null,
  data: { user: { id, email: id + '@example.invalid' } } }) as ReturnType<typeof useAuthSession>;

describe('Moodle account management handoff', () => {
  beforeEach(() => {
    vi.clearAllMocks(); deployment.billing = true; deployment.youtube = true;
    globalThis.__setMockPathname('/moodle/manage'); globalThis.__setMockSearchParams(query);
    vi.mocked(useAuthSession).mockReturnValue(signedIn());
  });
  afterEach(() => { globalThis.__setMockPathname('/'); globalThis.__setMockSearchParams(''); vi.unstubAllGlobals(); });

  it('requires independent sign-in and preserves the complete registration request', () => {
    const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher);
    vi.mocked(useAuthSession).mockReturnValue({ ...signedIn(), data: null });
    render(<MoodleManagementPage />);
    fireEvent.click(screen.getByRole('button', { name: 'auth.moodleConnect.login' }));
    expect(useI18nNavigate()).toHaveBeenCalledWith('/login?next=' + encodeURIComponent('/moodle/manage' + query));
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('offers account navigation only after checking the exact tuple with session credentials', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify(context()))); vi.stubGlobal('fetch', fetcher);
    render(<MoodleManagementPage />);
    expect(await screen.findByRole('link', { name: 'auth.moodleManagement.library' })).toHaveAttribute('href', '/videos');
    expect(screen.getByRole('link', { name: 'auth.moodleManagement.billing' })).toHaveAttribute('href', '/settings#billing');
    expect(screen.getByRole('link', { name: 'auth.moodleManagement.integrations' })).toHaveAttribute('href', '/settings#integrations');
    expect(screen.queryByRole('link', { name: 'auth.moodleManagement.admin' })).not.toBeInTheDocument();
    const [url, options] = fetcher.mock.calls[0];
    expect(url).toMatch(/\/lms\/pairing\/management$/);
    expect(options.credentials).toBe('include'); expect(JSON.parse(options.body)).toEqual(tuple);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('does not offer another account’s library, secrets or billing', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify(context(false)))));
    render(<MoodleManagementPage />);
    expect(await screen.findByRole('alert')).toHaveTextContent('auth.moodleManagement.notOwner');
    expect(screen.queryByRole('navigation')).not.toBeInTheDocument();
  });

  it('uses the independent server admin decision without granting ownership of the connection', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify(context(false, true)))));
    render(<MoodleManagementPage />);
    expect(await screen.findByRole('link', { name: 'auth.moodleManagement.admin' })).toHaveAttribute('href', '/admin');
    expect(screen.queryByRole('link', { name: 'auth.moodleManagement.billing' })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'auth.moodleManagement.library' })).not.toBeInTheDocument();
  });

  it('keeps on-prem navigation free of unavailable billing and search-key links', async () => {
    deployment.billing = false; deployment.youtube = false;
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify(context()))));
    render(<MoodleManagementPage />);
    await screen.findByRole('link', { name: 'auth.moodleManagement.library' });
    expect(screen.queryByRole('link', { name: 'auth.moodleManagement.billing' })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'auth.moodleManagement.searchKey' })).not.toBeInTheDocument();
  });

  it.each([500, 401])('fails closed when context verification returns HTTP %s', async status => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}', { status })));
    render(<MoodleManagementPage />);
    if (status === 401) await screen.findByRole('button', { name: 'auth.moodleConnect.login' });
    else expect(await screen.findByRole('alert')).toHaveTextContent('auth.moodleManagement.error');
    expect(screen.queryByRole('navigation')).not.toBeInTheDocument();
  });

  it('ignores a late response for an account that has been switched', async () => {
    let finish!: (response: Response) => void;
    const fetcher = vi.fn().mockReturnValueOnce(new Promise<Response>(resolve => { finish = resolve; }))
      .mockResolvedValueOnce(new Response(JSON.stringify(context(false))));
    vi.stubGlobal('fetch', fetcher);
    const view = render(<MoodleManagementPage />);
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
    vi.mocked(useAuthSession).mockReturnValue(signedIn('other'));
    view.rerender(<MoodleManagementPage />);
    await screen.findByRole('alert');
    await act(async () => finish(new Response(JSON.stringify(context()))));
    expect(screen.queryByRole('navigation')).not.toBeInTheDocument();
  });

  it('requires an explicit account-switch action and preserves the registration context', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify(context(false)))));
    vi.mocked(authClient.signOut).mockResolvedValue({ data: { success: true }, error: null });
    render(<MoodleManagementPage />); await screen.findByRole('alert');
    expect(authClient.signOut).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'auth.moodleManagement.switchAccount' }));
    await waitFor(() => expect(useI18nNavigate()).toHaveBeenCalledWith('/login?next=' + encodeURIComponent('/moodle/manage' + query)));
    expect(authClient.signOut).toHaveBeenCalledTimes(1);
  });

  it('rejects extra redirect parameters before making an authenticated request', () => {
    const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher);
    globalThis.__setMockSearchParams(query + '&next=https://evil.example');
    render(<MoodleManagementPage />);
    expect(screen.getByRole('alert')).toHaveTextContent('auth.moodleManagement.invalid');
    expect(fetcher).not.toHaveBeenCalled();
  });
});
