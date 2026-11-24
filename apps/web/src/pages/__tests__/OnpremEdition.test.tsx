import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import LoginPage from '../LoginPage';
import SettingsPage from '../SettingsPage';
import { AppFooter } from '@/components/layout/AppFooter';
import { AppNav } from '@/components/layout/AppNav';
import { CourseParticipantsDialog } from '@/components/video/course-detail/CourseParticipantsDialog';
import { OnpremUserProvisioning, ResetUserAccessButton } from '@/components/auth/OnpremUserProvisioning';

vi.mock('@/lib/deployment', () => ({ isOnprem: true, features: {
  billing: false, marketing: false, publicSignup: false, googleLogin: false, youtube: false, emailDelivery: false,
} }));

beforeEach(() => {
  globalThis.__setMockAuthSession({ user: { id: "1", name: "operator" } });
  globalThis.__setTrpcHandler('account.me', async () => ({ id: '1', username: 'operator', email: 'operator@example.test', is_admin: true }));
  globalThis.__setTrpcHandler('account.integrationApiKeys', async () => []);
  globalThis.__setTrpcHandler('account.connectedApps', async () => []);
});

describe('on-prem user flows', () => {
  it('provides local sign-in with administrator help, without SaaS sign-up or Google actions', () => {
    render(<LoginPage />);
    expect(screen.getByText('onprem.loginHelp')).toBeInTheDocument();
    expect(document.querySelector('a[href*="signup"], a[href*="forgot-password"]')).toBeNull();
    expect(screen.queryByText('auth.login.orDivider')).not.toBeInTheDocument();
    expect(screen.queryByText('auth.login.google')).not.toBeInTheDocument();
  });
  it('excludes commercial pages from navigation and footer', async () => {
    render(<><AppNav /><AppFooter /></>);
    expect(document.querySelector('a[href="/"]')).not.toBeNull();
    for (const page of ['pricing', 'terms', 'privacy', 'refund', 'legal', 'signup']) {
      expect(document.querySelector(`a[href="/${page}"]`), page).toBeNull();
    }
  });
  it('keeps account and local API settings while avoiding billing and TranscriptAPI requests', async () => {
    const external = vi.fn(() => { throw new Error('Disabled API was requested'); });
    globalThis.__setTrpcHandler('account.searchApiKeyStatus', external);
    render(<SettingsPage />);
    await screen.findByText('settings.title');
    expect(document.querySelector('#billing, #youtube')).toBeNull();
    expect(document.querySelector('#account, #integrations')).not.toBeNull();
    expect(external).not.toHaveBeenCalled();
  });
  it('lets an administrator create an account and receive a private setup link', async () => {
    const create = vi.fn(async () => ({ id: 'new-user', username: 'new_user', email: 'new@example.test', activation_url: 'https://intranet.test/setup-secret' }));
    globalThis.__setTrpcHandler('admin.createUser', create);
    render(<OnpremUserProvisioning />);
    fireEvent.change(screen.getByLabelText('auth.fields.username.label'), { target: { value: 'new_user' } });
    fireEvent.change(screen.getByLabelText('auth.fields.email.label'), { target: { value: 'new@example.test' } });
    fireEvent.submit(screen.getByLabelText('auth.fields.email.label').closest('form')!);
    expect(await screen.findByLabelText('onprem.activationLink')).toHaveValue('https://intranet.test/setup-secret');
    expect(create).toHaveBeenCalledWith({ username: 'new_user', email: 'new@example.test' });
    const link = screen.getByLabelText('onprem.activationLink');
    fireEvent.focus(link);
    expect((link as HTMLInputElement).selectionEnd).toBe('https://intranet.test/setup-secret'.length);
    fireEvent.click(screen.getByRole('button', { name: 'common.actions.close' }));
    await waitFor(() => expect(screen.queryByLabelText('onprem.activationLink')).not.toBeInTheDocument());
  });
  it('provides administrator-assisted password recovery', async () => {
    const reset = vi.fn(async () => ({ activation_url: 'https://intranet.test/recovery-secret' }));
    globalThis.__setTrpcHandler('admin.resetAccess', reset);
    render(<ResetUserAccessButton id="user-id" username="alice" />);
    fireEvent.click(screen.getByRole('button'));
    await waitFor(() => expect(reset).toHaveBeenCalledWith({ id: 'user-id' }));
    expect(await screen.findByLabelText('onprem.activationLink')).toHaveValue('https://intranet.test/recovery-secret');
    fireEvent.click(screen.getByRole('button', { name: 'common.actions.close' }));
    await waitFor(() => expect(screen.queryByLabelText('onprem.activationLink')).not.toBeInTheDocument());
  });
  it('copies a setup link and keeps manual selection available when the clipboard is unavailable', async () => {
    const previous = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    try {
      globalThis.__setTrpcHandler('admin.resetAccess', async () => ({ activation_url: 'https://intranet.test/private-setup' }));
      render(<ResetUserAccessButton id="user-id" username="alice" />);
      fireEvent.click(screen.getByRole('button'));
      const link = await screen.findByLabelText('onprem.activationLink');
      fireEvent.click(screen.getByRole('button', { name: 'onprem.copyLink' }));
      await screen.findByRole('button', { name: 'onprem.copied' });
      expect(writeText).toHaveBeenCalledWith('https://intranet.test/private-setup');
      writeText.mockRejectedValueOnce(new Error('Clipboard denied'));
      fireEvent.click(screen.getByRole('button', { name: 'onprem.copied' }));
      await screen.findByRole('button', { name: 'onprem.copyLink' });
      fireEvent.focus(link);
      expect((link as HTMLInputElement).selectionEnd).toBe('https://intranet.test/private-setup'.length);
    } finally {
      if (previous) Object.defineProperty(navigator, 'clipboard', previous);
      else Reflect.deleteProperty(navigator, 'clipboard');
    }
  });
  it('issues and reissues a course invitation as a private link without mail delivery controls', async () => {
    const pending = { id: 7, email: 'member@example.test', status: 'pending', delivery_status: 'queued',
      expires_at: '2026-10-30T00:00:00Z', created_at: '2026-10-23T00:00:00Z', last_sent_at: null, send_attempts: 0 };
    globalThis.__setTrpcHandler('courseMemberships.participants', async () => ({ invitations: [pending], members: [] }));
    const invite = vi.fn(async () => ({ results: [{ email: 'new@example.test', status: 'queued', invitation_url: 'https://intranet.test/course-invitations/initial' }] }));
    const reissue = vi.fn(async () => ({ invitation_url: 'https://intranet.test/course-invitations/renewed' }));
    globalThis.__setTrpcHandler('courseMemberships.invite', invite);
    globalThis.__setTrpcHandler('courseMemberships.resend', reissue);
    render(<CourseParticipantsDialog courseId={3} isOpen onOpenChange={vi.fn()} />);
    await screen.findByText('member@example.test');
    expect(screen.queryByText('videos.courseMembers.delivery.queued')).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('videos.courseMembers.emailLabel'), { target: { value: 'new@example.test' } });
    fireEvent.click(screen.getByRole('button', { name: 'onprem.issueCourseLinks' }));
    const initial = await screen.findByLabelText('onprem.courseInvitationLink: new@example.test');
    expect(initial).toHaveValue('https://intranet.test/course-invitations/initial');
    fireEvent.focus(initial);
    expect((initial as HTMLInputElement).selectionEnd).toBe('https://intranet.test/course-invitations/initial'.length);
    expect(invite).toHaveBeenCalledWith({ courseId: 3, emails: ['new@example.test'] });
    const reissueButton = screen.getByRole('button', { name: 'onprem.reissueCourseLink' });
    // The issued link renders before the mutation finishes refreshing participants.
    await waitFor(() => expect(reissueButton).toBeEnabled());
    fireEvent.click(reissueButton);
    expect(await screen.findByLabelText('onprem.courseInvitationLink: member@example.test')).toHaveValue('https://intranet.test/course-invitations/renewed');
    expect(reissue).toHaveBeenCalledWith({ courseId: 3, invitationId: 7 });
  });

});
