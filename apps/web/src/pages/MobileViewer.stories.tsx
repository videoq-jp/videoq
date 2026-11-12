import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, waitFor } from 'storybook/test';
import App from '@/App';
import i18n from '@/i18n/config';
import { authFixtures } from '../../.storybook/fixtures/auth';
import { course } from '../../.storybook/fixtures/detail';
import { landingCourse, landingDemoEvents } from '../../.storybook/fixtures/landing';
import { createChatPanelMock } from '../../.storybook/mocks/chatPanel';
import { success, trpcQuery } from '../../.storybook/mocks/network';

const demo = {
  ...landingCourse,
  description: '[videoq-campus-basics-v1] 国語・数学・理科・社会・英語を学び直す講座です。',
  videos: [{ ...landingCourse.videos[0], file: null, description: `[videoq-campus-basics-v1] japanese sha256:${'a'.repeat(64)}` },
    { ...landingCourse.videos[0], id: 93, title: '数学｜微分は何を表すのか', file: null }],
};
const meta = {
  title: 'Pages/Mobile viewer', component: App,
  parameters: {
    layout: 'fullscreen', pathname: '/try',
    api: { auth: authFixtures.loggedOut, trpc: [trpcQuery('courses.shared', success(demo))] },
    docs: { story: { inline: false } },
  },
  globals: { locale: 'ja', viewport: { value: 'mobile', isRotated: false } },
  async beforeEach({ msw, parameters }) {
    await Promise.all([import('./TryPage'), import('./VideoCourseDetailPage')]);
    const savedLocale = localStorage.getItem('videoq.locale');
    localStorage.removeItem('videoq.locale');
    const network = createChatPanelMock({ events: landingDemoEvents() }, parameters.api?.trpc);
    msw.use(...network.handlers);
    return () => {
      network.dispose();
      if (savedLocale === null) localStorage.removeItem('videoq.locale');
      else localStorage.setItem('videoq.locale', savedLocale);
    };
  },
} satisfies Meta<typeof App>;
export default meta;
type Story = StoryObj<typeof meta>;
const tabName = (tab: string) => i18n.t(`videos.shared.tabs.${tab}`);

export const Trial: Story = {
  async play({ canvas, userEvent }) {
    const input = await canvas.findByRole('textbox', { name: i18n.t('chat.placeholder') }, { timeout: 10000 });
    await expect(input).toBeVisible();
    const rect = input.getBoundingClientRect();
    await expect(rect.bottom).toBeLessThanOrEqual(window.innerHeight);
    const question = canvas.getByRole('button', { name: i18n.t('tryDemo.questions.derivative') });
    await userEvent.click(question);
    await waitFor(() => expect(input).toBeEnabled());
    const citation = await canvas.findByRole('button', { name: '伝わる説明のつくり方 00:00:23,400' });
    await expect(citation).toHaveTextContent('(0:23-0:38)');
    await expect(canvas.getByRole('button', { name: i18n.t('chat.showSuggestions') })).toHaveAttribute('aria-expanded', 'false');
    await expect(canvas.queryByRole('button', { name: i18n.t('tryDemo.questions.derivative') })).not.toBeInTheDocument();
    await userEvent.type(input, '説明をもう少し詳しく');
    await userEvent.click(canvas.getByRole('tab', { name: tabName('videos') }));
    await userEvent.click(canvas.getByRole('button', { name: /数学｜微分/ }));
    await userEvent.click(canvas.getByRole('tab', { name: tabName('assistant') }));
    await expect(input).toHaveValue('説明をもう少し詳しく');
    if (window.innerWidth < 1024) {
      await userEvent.click(input);
      await expect(canvas.getByRole('button', { name: i18n.t('videos.shared.showPlayer') })).toHaveAttribute('aria-expanded', 'false');
      await userEvent.click(citation);
      await expect(canvas.getByRole('button', { name: i18n.t('videos.shared.hidePlayer') })).toHaveAttribute('aria-expanded', 'true');
      await userEvent.click(canvas.getByRole('tab', { name: tabName('details') }));
      await expect(canvas.getByRole('tab', { name: tabName('qa') })).toBeVisible();
      await expect(canvas.getByText('国語・数学・理科・社会・英語を学び直す講座です。')).toBeVisible();
    }
    await expect(canvas.queryByText(/sha256:/)).not.toBeInTheDocument();
    await expect(canvas.queryByText(/\[videoq-campus-basics-v1\]/)).not.toBeInTheDocument();
    await userEvent.click(canvas.getByRole('tab', { name: tabName('assistant') }));
    await expect(input).toHaveValue('説明をもう少し詳しく');
  },
};
export const EnglishTrial: Story = { ...Trial, globals: { locale: 'en', viewport: { value: 'mobile', isRotated: false } } };
export const SharedCourse: Story = { parameters: { pathname: '/share/sample' } };
export const CourseOwner: Story = {
  parameters: { pathname: '/videos/courses/42', api: { auth: authFixtures.user, trpc: [trpcQuery('courses.get', success(course))] } },
  async play({ canvas, userEvent }) {
    const input = await canvas.findByRole('textbox', { name: i18n.t('chat.placeholder') }, { timeout: 10000 });
    await expect(input.getBoundingClientRect().bottom).toBeLessThanOrEqual(window.innerHeight);
    await userEvent.type(input, 'この講義について');
    await userEvent.click(canvas.getByRole('tab', { name: tabName('videos') }));
    await userEvent.click(canvas.getByRole('tab', { name: tabName('assistant') }));
    await expect(input).toHaveValue('この講義について');
  },
};
export const CourseMember: Story = {
  ...CourseOwner,
  parameters: { pathname: '/videos/courses/42', api: { auth: authFixtures.user, trpc: [trpcQuery('courses.get', success({ ...course, access_role: 'member' }))] } },
};

/** A resize event models the VisualViewport API used by mobile keyboards. */
export const KeyboardViewport: Story = {
  async play({ canvas, canvasElement, userEvent }) {
    const input = await canvas.findByRole('textbox', { name: i18n.t('chat.placeholder') }, { timeout: 10000 });
    await userEvent.type(input, '入力した質問を保持する');
    const viewport = window.visualViewport!;
    const originalHeight = Object.getOwnPropertyDescriptor(viewport, 'height');
    try {
      Object.defineProperty(viewport, 'height', { configurable: true, value: 460 });
      viewport.dispatchEvent(new Event('resize'));
      await waitFor(() => expect(canvasElement.querySelector('[data-course-viewer]')!.getBoundingClientRect().height).toBe(460));
      await expect(input.getBoundingClientRect().bottom).toBeLessThanOrEqual(460);
      await expect(input).toHaveValue('入力した質問を保持する');
      await expect(canvas.getByRole('button', { name: i18n.t('videos.shared.showPlayer') })).toHaveAttribute('aria-expanded', 'false');
    } finally {
      if (originalHeight) Object.defineProperty(viewport, 'height', originalHeight);
      else Reflect.deleteProperty(viewport, 'height');
      viewport.dispatchEvent(new Event('resize'));
    }
  },
};
export const SmallPhone: Story = {
  ...Trial,
  parameters: { viewport: { options: { smallPhone: { name: 'Small phone', styles: { width: '320px', height: '568px' }, type: 'mobile' } } } },
  globals: { locale: 'ja', viewport: { value: 'smallPhone', isRotated: false } },
};

export const EnglishSmallPhone: Story = {
  ...SmallPhone,
  globals: { locale: 'en', viewport: { value: 'smallPhone', isRotated: false } },
};
