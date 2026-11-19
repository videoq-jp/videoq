import type { Meta, StoryObj } from '@storybook/react-vite';
import { useTranslation } from 'react-i18next';
import { expect } from 'storybook/test';
import { OnpremUserProvisioning } from './OnpremUserProvisioning';
import { ConnectedAppCard } from './ConnectedAppCard';
import { TrialIntroduction } from '@/pages/TryPage';
import { authFixtures } from '../../../.storybook/fixtures/auth';
import { success, trpcMutation } from '../../../.storybook/mocks/network';

function DisclosureReview() {
  const { i18n } = useTranslation();
  return <main className="mx-auto max-w-3xl space-y-8 p-6">
    <h1 className="text-std-28B-150">{i18n.language === 'en' ? 'Disclosure controls' : '開閉操作の修正レビュー'}</h1>
    <section aria-label="Connected app"><ConnectedAppCard headingLevel="h2" name="Moodle" disabled={false} disconnecting={false} onDisconnect={() => {}}><p>Account and course connection details</p></ConnectedAppCard></section>
    <section aria-label="Trial introduction"><TrialIntroduction /></section>
    <section aria-label="On-prem user provisioning"><OnpremUserProvisioning /></section>
  </main>;
}
const meta = {
  title: 'Review/Disclosure controls', component: DisclosureReview,
  parameters: { a11y: { test: 'error' }, api: { auth: authFixtures.admin, trpc: [
    trpcMutation('admin.createUser', input => success({ id: 'example', username: input.username, email: input.email, activation_url: 'https://videoq.example/activate/demo' })),
  ] } },
} satisfies Meta<typeof DisclosureReview>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Keyboard: Story = {
  async play({ canvasElement, userEvent }) {
    const summaries = [...canvasElement.querySelectorAll('summary')];
    await expect(summaries).toHaveLength(3);
    for (const summary of summaries) {
      summary.focus();
      await expect(summary).toHaveFocus();
      await expect(summary.getBoundingClientRect().height).toBeGreaterThanOrEqual(44);
      // Native summary activation with Enter/Space is verified in ego-browser.
      await userEvent.click(summary);
      await expect(summary.parentElement).toHaveAttribute('open');
      await userEvent.click(summary);
      await expect(summary.parentElement).not.toHaveAttribute('open');
    }
  },
};
export const Mobile: Story = { ...Keyboard, globals: { locale: 'ja', viewport: { value: 'mobile', isRotated: false } } };
export const EnglishMobile: Story = { ...Keyboard, globals: { locale: 'en', viewport: { value: 'mobile', isRotated: false } } };
