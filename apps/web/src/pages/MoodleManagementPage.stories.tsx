import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within } from 'storybook/test';
import { http, HttpResponse } from 'msw';
import { AuthLayout } from '@/components/layout/AuthLayout';
import { authFixture, regularUser } from '../../.storybook/fixtures/auth';
import MoodleManagementPage from './MoodleManagementPage';

const query = new URLSearchParams({ issuer: 'https://moodle.example:9443/academy', clientId: 'registered-client', deploymentId: '23' });
const context = (owned = true, systemAdmin = false, active: boolean | null = true) => ({
  connection: { owned, active: owned ? active : null }, permissions: { account: owned, billing: owned, systemAdmin },
});
const handler = (value = context()) => http.post('/api/lms/pairing/management', () => HttpResponse.json(value));
const meta = {
  title: 'Pages/Moodle account management', component: MoodleManagementPage,
  parameters: { layout: 'fullscreen', pathname: '/moodle/manage?' + query.toString(),
    api: { auth: authFixture(regularUser), rest: [handler()] } },
  decorators: [(Story) => <AuthLayout><Story /></AuthLayout>],
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(await canvas.findByText('https://moodle.example:9443/academy')).toBeVisible();
    await expect(await canvas.findByRole('navigation', { name: /VideoQの管理|VideoQ management/ })).toBeVisible();
  },
} satisfies Meta<typeof MoodleManagementPage>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Owner: Story = {};
export const Mobile: Story = { globals: { viewport: { value: 'mobile', isRotated: false } } };
export const EnglishMobile: Story = { globals: { locale: 'en', viewport: { value: 'mobile', isRotated: false } } };
export const InactiveConnection: Story = { parameters: { api: { rest: [handler(context(true, false, false))] } } };
export const DifferentAccount: Story = {
  parameters: { api: { rest: [handler(context(false))] } },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(await canvas.findByRole('alert')).toBeVisible();
    await expect(canvas.queryByRole('navigation')).not.toBeInTheDocument();
  },
};
export const IndependentSystemAdmin: Story = {
  parameters: { api: { rest: [handler(context(false, true))] } },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(await canvas.findByRole('link', { name: /システム管理|system administration/ })).toBeVisible();
    await expect(canvas.queryByRole('link', { name: /決済ポータル|payment portal/ })).not.toBeInTheDocument();
  },
};
export const SignedOut: Story = {
  parameters: { api: { auth: authFixture(null) } },
  async play({ canvasElement }) {
    await expect(await within(canvasElement).findByRole('button', { name: /VideoQにログイン|Sign in to VideoQ/ })).toBeEnabled();
  },
};
