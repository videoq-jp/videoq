import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn, mocked, waitFor, within } from 'storybook/test';
import { http, HttpResponse } from 'msw';
import { AuthLayout } from '@/components/layout/AuthLayout';
import { authFixture, regularUser } from '../../.storybook/fixtures/auth';
import { returnToMoodle } from '@/lib/moodleConnect';
import MoodleConnectPage from './MoodleConnectPage';

const query = new URLSearchParams({ moodle_url: 'https://moodle.example:9443/academy', state: 'a'.repeat(64), code_challenge: 'b'.repeat(43) });
const approved = fn();
const meta = {
  title: 'Pages/Moodle connection',
  component: MoodleConnectPage,
  parameters: { layout: 'fullscreen', pathname: '/moodle/connect?' + query,
    api: { auth: authFixture(regularUser), rest: [http.post('/api/lms/pairing', async ({ request }) => {
      approved(await request.json());
      return HttpResponse.json({ code: 'VIDEOQ2.' + btoa(JSON.stringify({ origin: 'https://api.example', secret: 'c'.repeat(64) })) });
    })] } },
  decorators: [(Story) => <AuthLayout><Story /></AuthLayout>],
  beforeEach() { mocked(returnToMoodle).mockImplementation(() => {}); mocked(returnToMoodle).mockClear(); approved.mockClear(); },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(await canvas.findByText('https://moodle.example:9443/academy')).toBeVisible();
    await expect(canvas.getByRole('button', { name: /許可して|Allow and/ })).toBeEnabled();
    await expect(approved).not.toHaveBeenCalled();
  },
} satisfies Meta<typeof MoodleConnectPage>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Approval: Story = {};
export const Mobile: Story = { globals: { viewport: { value: 'mobile', isRotated: false } } };
export const EnglishMobile: Story = { globals: { locale: 'en', viewport: { value: 'mobile', isRotated: false } } };
export const Approved: Story = {
  async play({ canvasElement, userEvent }) {
    await userEvent.click(await within(canvasElement).findByRole('button', { name: /許可して|Allow and/ }));
    await waitFor(() => expect(returnToMoodle).toHaveBeenCalledTimes(1));
    await expect(approved).toHaveBeenCalledWith({ moodleUrl: 'https://moodle.example:9443/academy', codeChallenge: 'b'.repeat(43) });
    const target = new URL(mocked(returnToMoodle).mock.calls[0][0]);
    await expect(target.origin + target.pathname).toBe('https://moodle.example:9443/academy/local/videoq/connect.php');
    await expect(target.searchParams.get('state')).toBe('a'.repeat(64));
    await expect(target.searchParams.get('code')).toBe('c'.repeat(64));
  },
};
export const Cancelled: Story = {
  async play({ canvasElement, userEvent }) {
    await userEvent.click(await within(canvasElement).findByRole('button', { name: /キャンセルして|Cancel and/ }));
    await expect(approved).not.toHaveBeenCalled();
    await expect(new URL(mocked(returnToMoodle).mock.calls[0][0]).searchParams.get('error')).toBe('access_denied');
  },
};
export const SignedOut: Story = {
  parameters: { api: { auth: authFixture(null) } },
  async play({ canvasElement }) { await expect(await within(canvasElement).findByRole('button', { name: /VideoQにログイン|Sign in to VideoQ/ })).toBeEnabled(); },
};
export const Failed: Story = {
  parameters: { api: { auth: authFixture(regularUser), rest: [http.post('/api/lms/pairing', () => HttpResponse.json({}, { status: 500 }))] } },
  async play({ canvasElement, userEvent }) {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole('button', { name: /許可して|Allow and/ }));
    await expect(await canvas.findByRole('alert')).toBeVisible();
    await expect(returnToMoodle).not.toHaveBeenCalled();
  },
};
