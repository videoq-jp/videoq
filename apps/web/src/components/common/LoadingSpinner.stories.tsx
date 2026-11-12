import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect } from 'storybook/test';
import i18n from '@/i18n/config';
import { LoadingSpinner } from './LoadingSpinner';
import { AppPageShell } from '@/components/layout/AppPageShell';
import { authFixtures } from '../../../.storybook/fixtures/auth';

const meta = {
  title: 'Common/LoadingSpinner',
  component: LoadingSpinner,
  parameters: { a11y: { test: 'error' } },
  args: { message: '動画を読み込み中…' },
  decorators: [(Story, { args }) => args.fullScreen ? <Story /> : <div className="max-w-xl"><Story /></div>],
  async play({ canvas, args }) {
    const indicator = canvas.getByRole('progressbar', { name: args.message ?? i18n.t('common.messages.loading') });
    await expect(indicator).toBeVisible();
    if (args.fullScreen) {
      const bounds = indicator.getBoundingClientRect();
      // The root content box excludes both visible scrollbars and a reserved
      // scrollbar-gutter. clientWidth includes the latter in standards mode.
      const viewport = document.documentElement;
      await expect(Math.abs(bounds.x + bounds.width / 2 - viewport.getBoundingClientRect().width / 2)).toBeLessThan(1);
      await expect(Math.abs(bounds.y + bounds.height / 2 - viewport.clientHeight / 2)).toBeLessThan(1);
      const footer = canvas.queryByRole('contentinfo');
      if (footer) await expect(footer.getBoundingClientRect().top).toBeGreaterThanOrEqual(bounds.bottom);
    }
  },
} satisfies Meta<typeof LoadingSpinner>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Loading: Story = {};
export const DefaultLoadingMessage: Story = { args: { message: undefined } };
export const EnglishMobile: Story = {
  args: { message: 'Loading your videos. This may take a moment…' },
  globals: { locale: 'en', viewport: { value: 'mobile', isRotated: false } },
};
export const FullScreen: Story = {
  args: { fullScreen: true },
  parameters: { layout: 'fullscreen', docs: { story: { inline: false, height: '600px' } } },
};
export const FullScreenMobile: Story = {
  ...FullScreen,
  globals: { viewport: { value: 'mobile', isRotated: false } },
};
export const FullScreenInPage: Story = {
  ...FullScreen,
  parameters: { ...FullScreen.parameters, api: { auth: authFixtures.user } },
  render: args => <AppPageShell><LoadingSpinner {...args} /></AppPageShell>,
};
export const FullScreenInPageWithScrollbars: Story = {
  ...FullScreenInPage,
  render: args => (
    <>
      <style>{'html { overflow-y: scroll; } ::-webkit-scrollbar { width: 16px; }'}</style>
      <AppPageShell><LoadingSpinner {...args} /></AppPageShell>
    </>
  ),
};
export const FullScreenInPageLandscape: Story = {
  ...FullScreenInPage,
  // Vitest's viewport adapter ignores isRotated, so give it the actual dimensions.
  parameters: {
    ...FullScreenInPage.parameters,
    viewport: { options: { landscape: { name: 'Landscape', styles: { width: '844px', height: '390px' }, type: 'mobile' } } },
  },
  globals: { viewport: { value: 'landscape', isRotated: false } },
};
export const FullScreenInPageSmallMobile: Story = {
  ...FullScreenInPage,
  parameters: {
    ...FullScreenInPage.parameters,
    viewport: { options: { smallMobile: { name: 'Small mobile', styles: { width: '320px', height: '568px' }, type: 'mobile' } } },
  },
  globals: { viewport: { value: 'smallMobile', isRotated: false } },
};
