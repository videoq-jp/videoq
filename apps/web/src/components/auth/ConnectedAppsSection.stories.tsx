import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn, waitFor, within } from 'storybook/test';
import { http, HttpResponse } from 'msw';
import { authFixtures } from '../../../.storybook/fixtures/auth';
import { consents, englishClientNames, longClientNames, longConsents, revokeConsentPath } from '../../../.storybook/fixtures/connectedApps';
import { failure, pending, restPost, success, trpcHandler, trpcQuery } from '../../../.storybook/mocks/network';
import { ConnectedAppsSection } from './ConnectedAppsSection';

interface AppFixture {
  moodle?: boolean;
  moodleUrl?: string;
  consents?: typeof consents;
  names?: Record<string, string>;
  load?: 'pending' | 'error';
  revoke?: 'pending' | 'error' | 'retry';
  failListAfterRevoke?: boolean;
}
const revokeRequest = fn();
const listRequest = fn();
const successMessage = /アプリとの連携を解除しました|App disconnected/;
const errorMessage = /連携の解除に失敗しました|Failed to disconnect app/;

async function firstRevokeButton(canvasElement: HTMLElement) {
  const table = await within(canvasElement).findByRole('list');
  return within(within(table).getAllByRole('listitem')[0]).getByRole('button', { name: /連携を解除|Disconnect/ });
}

const meta = {
  title: 'Auth/ConnectedAppsSection',
  component: ConnectedAppsSection,
  parameters: { pathname: '/settings', api: { auth: authFixtures.user }, docs: { story: { inline: false, height: '640px' } } },
  decorators: [(Story) => <div className="mx-auto max-w-5xl p-2"><Story /></div>],
  beforeEach({ parameters, msw }) {
    const fixture: AppFixture = parameters.connectedApps ?? {};
    let rows = structuredClone(fixture.consents ?? consents).map(row => ({ ...row, client_name: fixture.names?.[row.client_id] ?? row.client_name }));
    let attempts = 0;
    revokeRequest.mockClear();
    listRequest.mockClear();
    msw.use(
      http.get('/api/lms/pairing', () => fixture.moodle
        ? HttpResponse.json({ connections: [{ id: 'school', moodleUrl: fixture.moodleUrl ?? 'https://school.example', active: true }] })
        : new HttpResponse(null, { status: 404 })),
      trpcHandler([trpcQuery('account.connectedApps', () => {
        listRequest();
        if (fixture.load) return fixture.load === 'pending' ? pending() : failure();
        return attempts > 0 && fixture.failListAfterRevoke ? failure('List unavailable') : success(rows);
      })]),
      fixture.revoke === 'pending' ? restPost(revokeConsentPath, pending())
        : http.post(revokeConsentPath, async ({ request }) => {
          const body = await request.json() as { id: string };
          revokeRequest(body);
          attempts++;
          if (fixture.revoke === 'error' || (fixture.revoke === 'retry' && attempts === 1)) {
            return HttpResponse.json({ message: 'Fixture revoke failed', code: 'INTERNAL_SERVER_ERROR' }, { status: 500 });
          }
          const grant = rows.find((row) => row.id === body.id);
          if (!grant) return HttpResponse.json({ message: 'Authorization not found' }, { status: 404 });
          rows = rows.filter((row) => row.client_id !== grant.client_id);
          return HttpResponse.json({ success: true });
        }),
    );
  },
  async play({ canvasElement }) {
    await expect(await within(canvasElement).findByRole('list')).toBeVisible();
  },
} satisfies Meta<typeof ConnectedAppsSection>;
export default meta;
type Story = StoryObj<typeof meta>;

export const MultipleApps: Story = {
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    const table = await canvas.findByRole('list');
    await expect(within(table).getAllByRole('listitem')).toHaveLength(2);
    await expect(canvas.getByText('授業サポート')).toBeVisible();
    await expect(canvas.getByText('学習ノート')).toBeVisible();
  },
};
export const Empty: Story = {
  parameters: { connectedApps: { consents: [] } satisfies AppFixture },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(await canvas.findByText(/現在連携中のアプリはありません。|No apps are currently connected./)).toBeVisible();
    await expect(canvas.queryByRole('list')).not.toBeInTheDocument();
  },
};
export const Loading: Story = {
  parameters: { connectedApps: { load: 'pending' } satisfies AppFixture },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('progressbar')).toBeVisible();
    await expect(canvas.queryByRole('list')).not.toBeInTheDocument();
  },
};
export const LoadFailed: Story = {
  parameters: { connectedApps: { load: 'error' } satisfies AppFixture },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(await canvas.findByText(/連携アプリの読み込みに失敗しました|Failed to load connected apps/)).toBeVisible();
    await expect(canvas.queryByRole('list')).not.toBeInTheDocument();
  },
};
export const LongContent: Story = { parameters: { connectedApps: { consents: longConsents, names: longClientNames } satisfies AppFixture } };
export const LongContentMobile: Story = {
  ...LongContent,
  globals: { viewport: { value: 'mobile', isRotated: false } },
  async play({ canvasElement }) {
    const list = await within(canvasElement).findByRole('list');
    await expect(list.scrollWidth).toBeLessThanOrEqual(canvasElement.ownerDocument.documentElement.clientWidth);
    for (const action of within(list).getAllByRole('button')) {
      const bounds = action.getBoundingClientRect();
      await expect(bounds.left).toBeGreaterThanOrEqual(0);
      await expect(bounds.right).toBeLessThanOrEqual(canvasElement.ownerDocument.documentElement.clientWidth);
    }
  },
};
export const EnglishMobile: Story = {
  globals: { locale: 'en', viewport: { value: 'mobile', isRotated: false } },
  parameters: { connectedApps: { names: englishClientNames } satisfies AppFixture },
  async play({ canvasElement }) {
    await expect(await within(canvasElement).findByText('Classroom assistant')).toBeVisible();
  },
};
export const RevokePending: Story = {
  parameters: { connectedApps: { revoke: 'pending' } satisfies AppFixture },
  async play({ canvasElement, userEvent }) {
    const button = await firstRevokeButton(canvasElement);
    await userEvent.click(button);
    await userEvent.click(within(within(canvasElement).getByRole('dialog')).getByRole('button', { name: /連携を解除|Disconnect/ }));
    await waitFor(() => expect(button).toBeDisabled());
    for (const action of within(canvasElement).getAllByRole('button')) await expect(action).toBeDisabled();
    await expect(button).toHaveAttribute('aria-busy', 'true');
    await expect(within(canvasElement).getAllByRole('listitem')).toHaveLength(2);
  },
};
export const RevokeWithoutListRefresh: Story = {
  parameters: { connectedApps: { failListAfterRevoke: true } satisfies AppFixture },
  async play({ canvasElement, userEvent }) {
    const button = await firstRevokeButton(canvasElement);
    await userEvent.click(button);
    await userEvent.click(within(within(canvasElement).getByRole('dialog')).getByRole('button', { name: /連携を解除|Disconnect/ }));
    await waitFor(() => expect(revokeRequest).toHaveBeenCalledTimes(1));
    await expect(await within(canvasElement).findByText(successMessage)).toBeVisible();
    await waitFor(() => expect(button).not.toBeInTheDocument());
    const list = within(canvasElement).getByRole('list');
    await expect(within(list).getAllByRole('listitem')).toHaveLength(1);
    await expect(within(list).getByRole('button')).toBeEnabled();
    await expect(revokeRequest).toHaveBeenCalledTimes(1);
    await expect(listRequest).toHaveBeenCalledTimes(1);
  },
};
export const RevokeFailed: Story = {
  parameters: { connectedApps: { revoke: 'error' } satisfies AppFixture },
  async play({ canvasElement, userEvent }) {
    const button = await firstRevokeButton(canvasElement);
    await userEvent.click(button);
    await userEvent.click(within(within(canvasElement).getByRole('dialog')).getByRole('button', { name: /連携を解除|Disconnect/ }));
    await expect(await within(canvasElement).findByText(errorMessage)).toBeVisible();
    await waitFor(() => expect(button).toBeEnabled());
    await expect(within(canvasElement).getAllByRole('listitem')).toHaveLength(2);
  },
};
export const RevokeSucceeded: Story = {
  async play({ canvasElement, userEvent }) {
    await userEvent.click(await firstRevokeButton(canvasElement));
    await userEvent.click(within(within(canvasElement).getByRole('dialog')).getByRole('button', { name: /連携を解除|Disconnect/ }));
    const canvas = within(canvasElement);
    await expect(await canvas.findByText(successMessage)).toBeVisible();
    await waitFor(() => expect(canvas.queryByText('授業サポート')).not.toBeInTheDocument());
    await expect(canvas.getByText('学習ノート')).toBeVisible();
    await expect(revokeRequest).toHaveBeenCalledTimes(1);
    await expect(revokeRequest).toHaveBeenCalledWith({ id: consents[0].id });
  },
};
export const RevokeMultipleGrants: Story = {
  parameters: { connectedApps: {
    consents: [consents[0], { ...consents[0], id: 'classroom-extra-grant', scope: 'videoq.write' }, consents[1]],
  } satisfies AppFixture },
  async play({ canvasElement, userEvent }) {
    const canvas = within(canvasElement);
    const list = await canvas.findByRole('list');
    await expect(within(list).getAllByRole('listitem')).toHaveLength(3);
    await userEvent.click(await firstRevokeButton(canvasElement));
    await userEvent.click(within(canvas.getByRole('dialog')).getByRole('button', { name: /連携を解除|Disconnect/ }));
    await expect(await canvas.findByText(successMessage)).toBeVisible();
    await waitFor(() => expect(canvas.queryAllByText('授業サポート')).toHaveLength(0));
    await expect(within(list).getAllByRole('listitem')).toHaveLength(1);
    await expect(canvas.getByText('学習ノート')).toBeVisible();
    await expect(revokeRequest).toHaveBeenCalledTimes(1);
    await expect(revokeRequest).toHaveBeenCalledWith({ id: consents[0].id });
    await expect(listRequest).toHaveBeenCalledTimes(1);
  },
};
export const FailureThenRetry: Story = {
  parameters: { connectedApps: { revoke: 'retry' } satisfies AppFixture },
  async play({ canvasElement, userEvent }) {
    const button = await firstRevokeButton(canvasElement);
    const canvas = within(canvasElement);
    await userEvent.click(button);
    await userEvent.click(within(within(canvasElement).getByRole('dialog')).getByRole('button', { name: /連携を解除|Disconnect/ }));
    await expect(await canvas.findByText(errorMessage)).toBeVisible();
    await waitFor(() => expect(button).toBeEnabled());
    await userEvent.click(button);
    await userEvent.click(within(within(canvasElement).getByRole('dialog')).getByRole('button', { name: /連携を解除|Disconnect/ }));
    await expect(await canvas.findByText(successMessage)).toBeVisible();
    await waitFor(() => expect(canvas.queryByText('授業サポート')).not.toBeInTheDocument());
    await expect(revokeRequest).toHaveBeenCalledTimes(2);
  },
};
export const KeyboardRevokeLastApp: Story = {
  parameters: { connectedApps: { consents: [consents[0]] } satisfies AppFixture },
  async play({ canvasElement, userEvent }) {
    const button = await firstRevokeButton(canvasElement);
    await userEvent.tab();
    await expect(button).toHaveFocus();
    await userEvent.keyboard('{Enter}');
    const confirm = within(within(canvasElement).getByRole('dialog')).getByRole('button', { name: /連携を解除|Disconnect/ });
    confirm.focus();
    await userEvent.keyboard('{Enter}');
    const canvas = within(canvasElement);
    await expect(await canvas.findByText(/現在連携中のアプリはありません。|No apps are currently connected./)).toBeVisible();
    await expect(canvas.getByText(successMessage).closest('[tabindex="-1"]')).toHaveFocus();
  },
};

export const MoodleConnected: Story = {
  args: { headingLevel: 'h3' },
  parameters: { connectedApps: { consents: [], moodle: true } satisfies AppFixture },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    const apps = within(canvas.getByRole('region', { name: /連携アプリ|Connected Apps/ }));
    await expect(await apps.findByText('https://school.example', { exact: false })).toBeVisible();
    await expect(apps.getByRole('heading', { name: 'Moodle', level: 4 })).toBeVisible();
    await expect(apps.queryByText(/現在連携中のアプリはありません|No connected apps/i)).not.toBeInTheDocument();
  },
};

export const MoodleAndClaude: Story = {
  args: { headingLevel: 'h3' },
  parameters: { connectedApps: {
    moodle: true,
    moodleUrl: 'https://school-with-a-long-name.example.edu/learning/moodle',
    consents: [consents[0]],
    names: { [consents[0].client_id]: 'Claude' },
  } satisfies AppFixture },
  async play({ canvasElement, userEvent }) {
    const canvas = within(canvasElement);
    await expect(await canvas.findByRole('heading', { name: 'Moodle', level: 4 })).toBeVisible();
    await expect(await canvas.findByRole('heading', { name: 'Claude', level: 4 })).toBeVisible();
    const cards = canvas.getAllByRole('article');
    await expect(cards).toHaveLength(2);
    for (const card of cards) {
      await userEvent.click(within(card).getByText(/連携の詳細|Connection details/));
      await expect(card.querySelector('details')).toHaveAttribute('open');
      const button = within(card).getByRole('button', { name: /連携を解除|Disconnect/ });
      await userEvent.click(button);
      const dialog = canvas.getByRole('dialog');
      await expect(within(dialog).getByRole('button', { name: /^連携を解除$|^Disconnect$/ })).toBeVisible();
      await userEvent.click(within(dialog).getByRole('button', { name: /キャンセル|Cancel/ }));
      await expect(button).toHaveFocus();
    }
    await expect(canvas.getByRole('link', { name: /Moodleの設定方法|Set up Moodle/ })).toBeVisible();
    await expect(canvas.getByText(consents[0].scope)).toBeVisible();
  },
};
export const MoodleAndClaudeMobile: Story = {
  ...MoodleAndClaude,
  globals: { viewport: { value: 'mobile', isRotated: false } },
  async play(context) {
    await MoodleAndClaude.play?.(context);
    const canvas = within(context.canvasElement);
    const width = context.canvasElement.ownerDocument.documentElement.clientWidth;
    for (const card of canvas.getAllByRole('article')) {
      await expect(card.scrollWidth).toBeLessThanOrEqual(width);
      const bounds = within(card).getByRole('button', { name: /連携を解除|Disconnect/ }).getBoundingClientRect();
      await expect(bounds.left).toBeGreaterThanOrEqual(0);
      await expect(bounds.right).toBeLessThanOrEqual(width);
    }
  },
};
