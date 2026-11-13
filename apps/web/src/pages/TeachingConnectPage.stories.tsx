import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within } from 'storybook/test';
import { http, HttpResponse } from 'msw';
import { AuthLayout } from '@/components/layout/AuthLayout';
import { authFixture, regularUser } from '../../.storybook/fixtures/auth';
import TeachingConnectPage from './TeachingConnectPage';
const review = { provider: 'classroom', title: 'Classroom 中学数学', teacherName: '山田先生', contextId: 'math-a',
  courses: [{ id: 12, name: '中学数学 基礎講座' }, { id: 13, name: '数学 応用講座' }] };
const meta = { title: 'Pages/Teaching connection', component: TeachingConnectPage,
  parameters: { layout: 'fullscreen', pathname: '/teaching/connect?ticket=' + 'a'.repeat(64),
    api: { auth: authFixture(regularUser), rest: [http.post('/api/teaching/review', () => HttpResponse.json(review)),
      http.post('/api/teaching/connect', () => HttpResponse.json({ courseId: 12 }))] } },
  decorators: [(Story) => <AuthLayout><Story /></AuthLayout>],
  async play({ canvasElement }) { const canvas = within(canvasElement);
    await expect(await canvas.findByRole('combobox')).toBeVisible();
    await expect(canvas.getByRole('button', { name: 'このアカウントで接続' })).toBeEnabled();
  },
} satisfies Meta<typeof TeachingConnectPage>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Classroom: Story = {};
export const Mobile: Story = { globals: { viewport: { value: 'mobile', isRotated: false } } };
export const Moodle: Story = { parameters: { api: { rest: [http.post('/api/teaching/review', () => HttpResponse.json({ ...review, provider: 'moodle', title: 'Moodle 中学数学' }))] } },
  async play({ canvasElement }) { const canvas = within(canvasElement);await expect(await canvas.findByRole('combobox')).toBeVisible(); } };
export const Connected: Story = { async play({ canvasElement, userEvent }) { const canvas = within(canvasElement);
  await userEvent.click(await canvas.findByRole('button', { name: 'このアカウントで接続' }));
  await expect(await canvas.findByRole('status')).toHaveTextContent('接続しました。');
} };
export const AlreadyConnected: Story = { parameters: { api: { rest: [http.post('/api/teaching/review', () => HttpResponse.json(review)), http.post('/api/teaching/connect', () => HttpResponse.json({}, { status: 409 }))] } },
  async play({ canvasElement, userEvent }) { const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole('button', { name: 'このアカウントで接続' }));
    await expect(await canvas.findByRole('alert')).toHaveTextContent('このクラスはすでに接続されています。');
  } };
