import type { Meta, StoryObj } from '@storybook/react-vite';
import type { BillingPlan } from '@videoq/trpc';
import { http, HttpResponse } from 'msw';
import { expect, waitFor } from 'storybook/test';
import i18n from '@/i18n/config';
import LandingPage from './LandingPage';
import { authFixtures } from '../../.storybook/fixtures/auth';
import { failure, success, trpcQuery } from '../../.storybook/mocks/network';
import { landingMedia } from '../../.storybook/mocks/landingMedia';

const freePlan = {
  code: 'free', interval: null, lookup_key: null, unit_amount: 0, currency: 'jpy',
  entitlements: { max_video_upload_size_mb: 200, storage_limit_gb: 1, monthly_upload_limit_gb: 2, processing_limit_minutes: 45, ai_answers_limit: 30 },
} satisfies BillingPlan;
const meta = {
  title: 'Pages/Landing', component: LandingPage,
  parameters: { layout: 'fullscreen', a11y: { test: 'error' },
    api: { auth: authFixtures.loggedOut, trpc: [trpcQuery('billing.plans', success([freePlan]))], rest: [landingMedia] },
  },
  decorators: [Story => <main className="mx-auto w-full max-w-screen-xl px-6 pb-16 pt-8 lg:px-8"><Story /></main>],
  async play({ canvas, canvasElement }) {
    await expect(canvas.getByRole('heading', { level: 1 })).toHaveTextContent(i18n.t('landing.title'));
    await expect(canvas.getByRole('link', { name: i18n.t('landing.tryOwn') })).toHaveAttribute('href', i18n.language === 'en' ? '/en/signup' : '/signup');
    await expect(canvasElement.scrollWidth).toBeLessThanOrEqual(canvasElement.clientWidth);
    await expect(await canvas.findByText(i18n.t('landing.free.minutes', { minutes: 45 }))).toBeVisible();
    await expect(canvas.queryByRole('textbox')).not.toBeInTheDocument();
    await expect(canvas.getByRole('list', { name: i18n.t('landing.film.stepsLabel') }).children).toHaveLength(4);
    await expect(canvasElement.querySelector('video')).toHaveAttribute('preload', 'none');
  },
} satisfies Meta<typeof LandingPage>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Japanese: Story = {};
export const Mobile: Story = { globals: { viewport: { value: 'mobile', isRotated: false } } };
export const English: Story = { globals: { locale: 'en' } };
export const EnglishMobile: Story = { globals: { locale: 'en', viewport: { value: 'mobile', isRotated: false } } };
export const LegacyAdShowsDefaultUseCase: Story = {
  parameters: { pathname: '/?audience=training' },
  async play({ canvas }) {
    await expect(canvas.getByRole('button', { name: i18n.t('landing.uses.courses.label') })).toHaveAttribute('aria-pressed', 'true');
    await expect(canvas.getByRole('heading', { name: i18n.t('landing.uses.courses.title') })).toBeVisible();
  },
};
export const WatchDemo: Story = {
  async play({ canvas, canvasElement, userEvent }) {
    const video = canvasElement.querySelector('video')!;
    video.muted = true;
    const button=canvas.getByRole('button', {name:i18n.t('landing.film.play')});
    button.focus(); await userEvent.keyboard('{Enter}');
    await waitFor(()=>expect(video.currentTime).toBeGreaterThan(0),{timeout:10000});
    await expect(video.controls).toBe(true);
    await expect(video.duration).toBeCloseTo(30,0);
    await expect(video.videoWidth / video.videoHeight).toBeCloseTo(16 / 9,2);
    await expect(canvas.queryByRole('button', {name:i18n.t('landing.film.play')})).not.toBeInTheDocument();
    const seekTime = 20;
    video.currentTime=seekTime;
    await waitFor(async ()=>{await expect(video.currentTime).toBeGreaterThanOrEqual(seekTime);await expect(video.seeking).toBe(false);await expect(video.readyState).toBeGreaterThanOrEqual(2);},{timeout:10000});
    video.pause();
  },
};
export const WatchDemoMobile: Story = { ...WatchDemo, globals:{viewport:{value:'mobile',isRotated:false}} };
export const WatchDemoEnglish: Story = { ...WatchDemo, globals:{locale:'en'} };
export const VideoUnavailable: Story = {
  parameters:{api:{rest:[http.get('/demo/provider-demo-ja.mp4',()=>new HttpResponse(null,{status:503}))]}},
  async play({canvas,canvasElement,userEvent}) {
    const video=canvasElement.querySelector('video')!;
    video.muted = true;
    // Isolate this request from the browser's media cache populated by playback stories.
    video.src='/demo/provider-demo-ja.mp4?scenario=unavailable';
    await userEvent.click(canvas.getByRole('button',{name:i18n.t('landing.film.play')}));
    await expect(await canvas.findByText(i18n.t('landing.film.error'), {}, {timeout:5000})).toBeVisible();
    await expect(canvas.getByRole('button',{name:i18n.t('landing.film.retry')})).toBeEnabled();
    await expect(canvas.getByRole('link',{name:i18n.t('landing.tryOwn')})).toHaveAttribute('href','/signup');
  },
};
export const CatalogUnavailable: Story = {
  parameters:{api:{trpc:[trpcQuery('billing.plans',failure('Offline'))]}},
  async play({canvas}) {
    await expect(await canvas.findByText(i18n.t('landing.free.unavailable'))).toBeVisible();
    await expect(canvas.getByRole('button',{name:i18n.t('landing.film.play')})).toBeEnabled();
  },
};
export const UseCasesAndFaq: Story = {
  async play({canvas,userEvent}) {
    const training=canvas.getByRole('button',{name:i18n.t('landing.uses.training.label')});
    training.focus();await userEvent.keyboard(' ');
    await expect(training).toHaveAttribute('aria-pressed','true');
    await expect(canvas.getByRole('heading',{name:i18n.t('landing.uses.training.title')})).toBeVisible();
    await userEvent.click(canvas.getByText(i18n.t('landing.faq.accounts.question')));
    await expect(canvas.getByText(i18n.t('landing.faq.accounts.answer'))).toBeVisible();
  },
};
