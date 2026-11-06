import type { Meta, StoryObj } from '@storybook/react-vite';
import { http, HttpResponse } from 'msw';
import { expect, fn, waitFor, within } from 'storybook/test';
import i18n from '@/i18n/config';
import SettingsPage from './SettingsPage';
import { AppPageShell } from '@/components/layout/AppPageShell';
import { authFixture, regularUser } from '../../.storybook/fixtures/auth';
import { integrationApiKeys } from '../../.storybook/fixtures/api';
import { consents } from '../../.storybook/fixtures/connectedApps';
import { failure, restPost, success, trpcMutation, trpcQuery } from '../../.storybook/mocks/network';

const keyListRequest = fn();
const api = {
  auth: authFixture({ ...regularUser, username: 'yuki' }),
  trpc: [
    trpcQuery('account.searchApiKeyStatus', success({ has_api_key: false })),
    trpcQuery('account.integrationApiKeys', () => { keyListRequest(); return success(integrationApiKeys); }),
    trpcQuery('account.connectedApps', success(consents)),
  ],
  rest: [
    http.get('/api/lms/pairing', () => HttpResponse.json({ error: 'LMS_SYNC_DISABLED' }, { status: 404 })),
    restPost('/api/auth/change-email', success({ status: true })),
  ],
};

const meta = {
  title: 'Pages/Settings',
  component: SettingsPage,
  parameters: { layout: 'fullscreen', pathname: '/settings', api, docs: { story: { inline: false, height: '900px' } } },
  decorators: [(Story) => <AppPageShell activePage="settings"><Story /></AppPageShell>],
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(await canvas.findByText(/未設定|Not configured/)).toBeVisible();
    await expect(canvas.getByText('yuki')).toBeVisible();
    await expect(canvas.queryByRole('textbox')).not.toBeInTheDocument();
  },
} satisfies Meta<typeof SettingsPage>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};
export const Mobile: Story = { globals: { viewport: { value: 'mobile', isRotated: false } } };
export const EnglishMobile: Story = { globals: { locale: 'en', viewport: { value: 'mobile', isRotated: false } } };
export const Configured: Story = {
  parameters: { api: { ...api, trpc: [...api.trpc.slice(1), trpcQuery('account.searchApiKeyStatus', success({ has_api_key: true }))] } },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(await canvas.findByText(/設定済み|Configured/)).toBeVisible();
    await expect(canvas.queryByLabelText(/SearchAPIキー|SearchAPI key/)).not.toBeInTheDocument();
  },
};
export const LoadFailed: Story = {
  parameters: { api: { ...api, trpc: [...api.trpc.slice(1), trpcQuery('account.searchApiKeyStatus', failure())] } },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(await canvas.findByText(/設定状態を取得できませんでした|Unable to load SearchAPI settings/)).toBeVisible();
  },
};
export const EditUsernameMobile: Story = {
  ...Mobile,
  async play({ canvasElement, userEvent }) {
    const canvas = within(canvasElement);
    const edit = await canvas.findByRole('button', { name: /ユーザー名を変更する|Edit username/ });
    await userEvent.click(edit);
    const input = canvas.getByLabelText(/新しいユーザー名|New username/);
    await expect(input).toHaveFocus();
    await userEvent.clear(input);
    await userEvent.type(input, 'yuki_new');
    await expect(canvas.getByRole('button', { name: /ユーザー名を変更$|Change username/ })).toBeEnabled();
    await userEvent.click(within(canvas.getByRole('form')).getByRole('button', { name: /キャンセル|Cancel/ }));
    await expect(edit).toHaveFocus();
    await expect(canvas.queryByRole('form', { name: /ユーザー名|username/ })).not.toBeInTheDocument();
    await userEvent.click(edit);
    await expect(canvas.getByLabelText(/新しいユーザー名|New username/)).toHaveValue('yuki');
  },
};
export const EmailConfirmation: Story = {
  async play({ canvasElement, userEvent }) {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole('button', { name: /メールアドレスを変更する|Edit email address/ }));
    const input = canvas.getByLabelText(/新しいメールアドレス|New email address/);
    await userEvent.clear(input);
    await userEvent.type(input, 'new@example.test');
    await userEvent.click(canvas.getByRole('button', { name: /確認メールを送信|Send confirmation email/ }));
    await expect(await canvas.findByText(/確認メールを送信しました|Confirmation email sent/)).toBeVisible();
    await expect(canvas.getByText(regularUser.email)).toBeVisible();
    await expect(canvas.queryByLabelText(/新しいメールアドレス|New email address/)).not.toBeInTheDocument();
  },
};

const searchStatusRequest = fn();
const saveSearchKey = fn();
const deleteSearchKey = fn();
export const SearchApiKeyChanges: Story = {
  parameters: { api: { ...api, trpc: [
    ...api.trpc.slice(1),
    trpcQuery('account.searchApiKeyStatus', () => { searchStatusRequest(); return success({ has_api_key: false }); }),
    trpcMutation('account.saveSearchApiKey', input => { saveSearchKey(input); return success({ success: true }); }),
    trpcMutation('account.deleteSearchApiKey', () => { deleteSearchKey(); return success({ success: true }); }),
  ] } },
  beforeEach() {
    searchStatusRequest.mockClear(); saveSearchKey.mockClear(); deleteSearchKey.mockClear();
  },
  async play({ canvas, canvasElement, userEvent }) {
    const label = (key: string) => i18n.t(`settings.searchApiKey.${key}`);
    const input = await canvas.findByLabelText(label('apiKeyLabel'));
    await userEvent.type(input, '  fixture-search-key  ');
    await userEvent.click(canvas.getByRole('button', { name: label('show') }));
    await expect(input).toHaveAttribute('type', 'text');
    await userEvent.click(canvas.getByRole('button', { name: label('save') }));
    await expect(await canvas.findByText(label('configured'))).toBeVisible();
    await expect(saveSearchKey).toHaveBeenCalledTimes(1);
    await expect(saveSearchKey).toHaveBeenCalledWith({ apiKey: 'fixture-search-key' });
    await expect(canvas.queryByLabelText(label('apiKeyLabel'))).not.toBeInTheDocument();
    await userEvent.click(canvas.getByRole('button', { name: label('edit') }));
    await expect(canvas.getByLabelText(label('apiKeyLabel'))).toHaveValue('');
    await expect(canvas.getByLabelText(label('apiKeyLabel'))).toHaveAttribute('type', 'password');
    await userEvent.click(canvas.getByRole('button', { name: i18n.t('settings.cancel') }));
    await userEvent.click(canvas.getByRole('button', { name: label('delete') }));
    const dialog = within(canvas.getByRole('dialog'));
    dialog.getByRole('button', { name: label('delete') }).focus();
    await userEvent.keyboard('{Enter}');
    await waitFor(() => expect(canvas.queryByRole('dialog')).not.toBeInTheDocument());
    await expect(canvas.getByText(label('notConfigured'))).toBeVisible();
    await expect(canvas.getByLabelText(label('apiKeyLabel'))).toHaveValue('');
    await expect(deleteSearchKey).toHaveBeenCalledTimes(1);
    await expect(searchStatusRequest).toHaveBeenCalledTimes(1);
    await expect(canvasElement.scrollWidth).toBeLessThanOrEqual(canvasElement.clientWidth);
  },
};
export const SearchApiKeyChangesEnglishMobile: Story = {
  ...SearchApiKeyChanges, globals: { locale: 'en', viewport: { value: 'mobile', isRotated: false } },
};

const copyRequest = fn();
export const GeneratedKeyCopyRetry: Story = {
  parameters: { api: { ...api, rest: [...api.rest,
    restPost('/api/auth/api-key/create', success({
      id: 'generated-fixture', configId: 'read-write', name: 'Notebook', start: 'vq_fixture',
      key: 'fixture-only-generated-secret', createdAt: '2026-09-23T00:00:00Z',
    })),
  ] } },
  beforeEach() {
    keyListRequest.mockClear();
    const descriptor = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
    copyRequest.mockReset().mockRejectedValueOnce(new Error('Clipboard denied')).mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: copyRequest } });
    return () => {
      if (descriptor) Object.defineProperty(navigator, 'clipboard', descriptor);
      else Reflect.deleteProperty(navigator, 'clipboard');
    };
  },
  async play({ canvas, userEvent }) {
    const label = (key: string) => i18n.t(`settings.integrationApiKeys.${key}`);
    await canvas.findByText(integrationApiKeys[0].name);
    await userEvent.click(canvas.getByRole('button', { name: label('create') }));
    await userEvent.type(canvas.getByLabelText(label('nameLabel')), 'Notebook');
    await userEvent.click(canvas.getByRole('button', { name: label('createDialogCta') }));
    await expect(await canvas.findByText('fixture-only-generated-secret')).toBeVisible();
    await userEvent.click(canvas.getByRole('button', { name: label('copy') }));
    await expect(await canvas.findByText(label('errorCopying'))).toBeVisible();
    canvas.getByRole('button', { name: label('copy') }).focus();
    await userEvent.keyboard('{Enter}');
    await expect(await canvas.findByRole('button', { name: label('copyDone') })).toBeEnabled();
    await expect(canvas.queryByText(label('errorCopying'))).not.toBeInTheDocument();
    await expect(copyRequest).toHaveBeenCalledTimes(2);
    await expect(copyRequest).toHaveBeenLastCalledWith('fixture-only-generated-secret');
    await userEvent.click(canvas.getByRole('button', { name: label('generatedDoneCta') }));
    await expect(canvas.getByText('Notebook')).toBeVisible();
    await expect(canvas.getByText(integrationApiKeys[0].name)).toBeVisible();
    await expect(canvas.queryByText('fixture-only-generated-secret')).not.toBeInTheDocument();
    await expect(canvas.getByRole('button', { name: label('create') })).toBeEnabled();
    await expect(keyListRequest).toHaveBeenCalledTimes(1);
  },
};
export const GeneratedKeyCopyRetryEnglishMobile: Story = {
  ...GeneratedKeyCopyRetry, globals: { locale: 'en', viewport: { value: 'mobile', isRotated: false } },
};
