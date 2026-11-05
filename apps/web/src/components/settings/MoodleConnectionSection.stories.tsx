import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within } from 'storybook/test';
import { http, HttpResponse } from 'msw';
import { failure, pending, restPost, success } from '../../../.storybook/mocks/network';
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
    await expect(await canvas.findByRole('textbox')).toBeVisible();
    await expect(canvas.getByRole('button', { name: /接続コードを発行|Generate connection code/ })).toBeDisabled();
  },
};
export const Mobile: Story = { ...Empty, globals: { viewport: { value: 'mobile', isRotated: false } } };
export const EnglishMobile: Story = { ...Mobile, globals: { ...Mobile.globals, locale: 'en' } };

export const IssueCode: Story = {
  parameters: { api: { rest: [empty, http.post(endpoint, () => HttpResponse.json({ code: 'VIDEOQ2.story-fixture', moodleUrl: connection.moodleUrl, expiresAt: new Date(Date.now() + 600000).toISOString() }))] } },
  async play({ canvasElement, userEvent }) {
    const canvas = within(canvasElement);
    await userEvent.type(await canvas.findByRole('textbox'), connection.moodleUrl);
    await userEvent.click(canvas.getByRole('button', { name: /接続コードを発行|Generate connection code/ }));
    await expect(await canvas.findByDisplayValue('VIDEOQ2.story-fixture')).toBeVisible();
    await expect(canvas.getByRole('link')).toHaveAttribute('href', connection.moodleUrl + '/local/videoq/connect.php');
  },
};
export const Issuing: Story = {
  parameters: { api: { rest: [empty, restPost(endpoint, pending())] } },
  async play({ canvasElement, userEvent }) {
    const canvas = within(canvasElement);
    await userEvent.type(await canvas.findByRole('textbox'), connection.moodleUrl);
    await userEvent.click(canvas.getByRole('button', { name: /接続コードを発行|Generate connection code/ }));
    await expect(await canvas.findByRole('button', { name: /発行して|Generating/ })).toBeDisabled();
    await expect(canvas.getByRole('textbox')).toHaveValue(connection.moodleUrl);
  },
};
export const IssueFailed: Story = {
  parameters: { api: { rest: [empty, restPost(endpoint, failure())] } },
  async play({ canvasElement, userEvent }) {
    const canvas = within(canvasElement);
    await userEvent.type(await canvas.findByRole('textbox'), connection.moodleUrl);
    await userEvent.click(canvas.getByRole('button', { name: /接続コードを発行|Generate connection code/ }));
    await expect(await canvas.findByRole('alert')).toBeVisible();
    await expect(canvas.getByRole('textbox')).toHaveValue(connection.moodleUrl);
    await expect(canvas.getByRole('button', { name: /接続コードを発行|Generate connection code/ })).toBeEnabled();
  },
};
export const Disconnect: Story = {
  parameters: { api: { rest: [connected, restPost('/api/lms/pairing/connections/school/disconnect', success({ disconnected: true }))] } },
  async play({ canvasElement, userEvent }) {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole('button', { name: /接続を解除$|Disconnect$/ }));
    await userEvent.click(canvas.getByRole('button', { name: /キャンセル|Cancel/ }));
    await userEvent.click(canvas.getByRole('button', { name: /接続を解除$|Disconnect$/ }));
    await userEvent.click(canvas.getByRole('button', { name: /^解除する$|^Confirm disconnect$/ }));
    await expect(await canvas.findByRole('status')).toBeVisible();
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
