import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within } from 'storybook/test';
import { http, HttpResponse } from 'msw';
import { failure, restPost, success } from '../../../.storybook/mocks/network';
import { authFixture, regularUser } from '../../../.storybook/fixtures/auth';
import { MoodleConnectionSection } from './MoodleConnectionSection';

const endpoint = '/api/lms/pairing';
const connection = { id: 'school', moodleUrl: 'https://moodle.example.edu', active: true };
const empty = http.get(endpoint, () => HttpResponse.json({ connections: [] }));
const connected = http.get(endpoint, () => HttpResponse.json({ connections: [connection] }));
const meta = {
  title: 'Settings/Moodle connection',
  component: MoodleConnectionSection,
  parameters: { layout: 'padded', pathname: '/settings', api: { auth: authFixture(regularUser), rest: [empty] }, docs: { story: { inline: false } } },
  decorators: [(Story) => <div className="max-w-3xl"><Story /></div>],
} satisfies Meta<typeof MoodleConnectionSection>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Empty: Story = {
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(await canvas.findByRole('link')).toBeVisible();
    await expect(canvas.queryByRole('textbox')).not.toBeInTheDocument();
    await expect(canvas.queryByRole('button')).not.toBeInTheDocument();
  },
};
export const Mobile: Story = { ...Empty, globals: { viewport: { value: 'mobile', isRotated: false } } };
export const EnglishMobile: Story = { ...Mobile, globals: { ...Mobile.globals, locale: 'en' } };

export const Disconnect: Story = {
  parameters: { api: { rest: [connected, restPost('/api/lms/pairing/connections/school/disconnect', success({ disconnected: true }))] } },
  async play({ canvasElement, userEvent }) {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole('button', { name: /接続を解除$|Disconnect$/ }));
    await userEvent.click(canvas.getByRole('button', { name: /キャンセル|Cancel/ }));
    await userEvent.click(canvas.getByRole('button', { name: /接続を解除$|Disconnect$/ }));
    await userEvent.click(canvas.getByRole('button', { name: /^解除する$|^Confirm disconnect$/ }));
    await expect(await canvas.findByRole('status')).toBeVisible();
    await expect(canvasElement.querySelector('[data-connection-id="school"]')).not.toBeInTheDocument();
    await expect(canvas.queryByRole('button', { name: /接続を解除$|Disconnect$/ })).not.toBeInTheDocument();
  },
};
export const DisconnectFailed: Story = {
  parameters: { api: { rest: [connected, restPost('/api/lms/pairing/connections/school/disconnect', failure())] } },
  async play({ canvasElement, userEvent }) {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole('button', { name: /接続を解除$|Disconnect$/ }));
    await userEvent.click(canvas.getByRole('button', { name: /^解除する$|^Confirm disconnect$/ }));
    await expect(await canvas.findByRole('alert')).toBeVisible();
    await expect(canvas.getByRole('button', { name: /接続を解除$|Disconnect$/ })).toBeEnabled();
  },
};
