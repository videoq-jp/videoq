import type { Meta, StoryObj } from '@storybook/react-vite';
import { Route, Routes } from 'react-router-dom';
import { expect } from 'storybook/test';
import i18n from '@/i18n/config';
import GuidePage from './GuidePage';

const meta = {
  title: 'Pages/Guide',
  component: GuidePage,
  parameters: { pathname: '/guides/online-course-questions', layout: 'fullscreen' },
  decorators: [(Story) => (
    <main className="mx-auto max-w-screen-xl px-6 py-8">
      <Routes><Route path="guides/:slug" element={<Story />} /></Routes>
    </main>
  )],
  async play({ canvas, canvasElement }) {
    const prefix = i18n.language === 'en' ? '/en' : '';
    await expect(canvas.getByRole('heading', { level: 1 })).toBeVisible();
    await expect(canvas.getByRole('link', { name: i18n.t('guides.tryDemo') })).toHaveAttribute('href', `${prefix}/try`);
    await expect(canvas.getByRole('link', { name: i18n.t('guides.cta') })).toHaveAttribute('href', `${prefix}/signup`);
    await expect(canvas.getByRole('link', { name: i18n.t('guides.pricing') })).toHaveAttribute('href', `${prefix}/pricing`);
    await expect(canvasElement.scrollWidth).toBeLessThanOrEqual(canvasElement.clientWidth);
  },
} satisfies Meta<typeof GuidePage>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Japanese: Story = {};
export const JapaneseMobile: Story = { globals: { viewport: { value: 'mobile', isRotated: false } } };
export const English: Story = { globals: { locale: 'en' } };
export const EnglishMobile: Story = { globals: { locale: 'en', viewport: { value: 'mobile', isRotated: false } } };
