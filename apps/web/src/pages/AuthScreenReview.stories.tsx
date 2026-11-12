import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, waitFor } from 'storybook/test';
import App from '@/App';
import { authFixtures } from '../../.storybook/fixtures/auth';
import { success, trpcQuery } from '../../.storybook/mocks/network';

const invitation = {
  course_id: 42, course_name: '線形代数入門', inviter_name: '教材担当者',
  email_hint: 'l***@example.test', status: 'pending' as const, expires_at: '2099-01-01T00:00:00Z',
};
const meta = {
  title: 'Pages/Auth screen review', component: App,
  parameters: { layout: 'fullscreen', pathname: '/login', api: { auth: authFixtures.loggedOut } },
  async play({ canvas }) {
    await expect(await canvas.findByRole('heading', { level: 1 }, { timeout: 15000 })).toBeVisible();
    await waitFor(() => expect(canvas.queryByRole('progressbar', { name: /読み込み中|Loading/i })).not.toBeInTheDocument(), { timeout: 15000 });
  },
} satisfies Meta<typeof App>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Login: Story = {};
export const Signup: Story = { parameters: { pathname: '/signup' } };
export const CheckEmail: Story = { parameters: { pathname: '/signup/check-email' } };
export const SignupGoogleFailure: Story = { parameters: { pathname: '/signup/complete?error=access_denied' } };
export const SignupEmailFailure: Story = { parameters: { pathname: '/signup/verified?error=invalid_token' } };
export const ForgotPassword: Story = { parameters: { pathname: '/forgot-password' } };
export const ResetPasswordInvalid: Story = { parameters: { pathname: '/reset-password' } };
export const Consent: Story = { parameters: { pathname: '/consent', api: { auth: authFixtures.user } } };
export const Invitation: Story = { parameters: {
  pathname: '/course-invitations/sample', api: { auth: authFixtures.user, trpc: [trpcQuery('courseMemberships.preview', success(invitation))] },
} };
export const InvitationSignedOut: Story = { parameters: {
  pathname: '/course-invitations/sample', api: { auth: authFixtures.loggedOut, trpc: [trpcQuery('courseMemberships.preview', success(invitation))] },
} };
export const NotFound: Story = { parameters: { pathname: '/missing/audit-page' } };
