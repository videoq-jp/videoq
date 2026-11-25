import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect } from 'storybook/test';
import i18n from '@/i18n/config';
import { InstallSkillButton } from './InstallSkillDialog';
import { publishedSkillSet } from '../../../.storybook/fixtures/agentSkill';
import { failure, success, trpcMutation, trpcQuery } from '../../../.storybook/mocks/network';

let step = 0;
const stages = ['extracting', 'planning', 'synthesizing', 'auditing', 'published'] as const;
const meta = {
  title: 'Video/Install skill', component: InstallSkillButton, args: { kind: 'course', resourceId: 42 },
  parameters: { a11y: { test: 'error' }, api: { trpc: [
    trpcMutation('skills.start', () => success({ ...publishedSkillSet, stage: 'extracting', members: [], completedChunks: 0, draft: null, markdown: null, sourcesMarkdown: null, skillName: null })),
    trpcMutation('skills.advance', () => { const stage = stages[Math.min(++step, 4)]; return success({ ...publishedSkillSet, stage, members: stage === 'planning' ? [] : publishedSkillSet.members?.map(member => ({ ...member, status: stage === 'published' ? 'passed' : 'pending' })) }); }),
    trpcQuery('skills.get', () => success(publishedSkillSet)),
    trpcMutation('skills.publish', () => success({ ...publishedSkillSet, stage: 'published' })),
  ] } },
  beforeEach() { step = 0; localStorage.removeItem('videoq:skill-job:course:42'); localStorage.removeItem('videoq:skill-job:video:7'); },
} satisfies Meta<typeof InstallSkillButton>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Course: Story = {};
export const Video: Story = { args: { kind: 'video', resourceId: 7 } };
export const GenerateAndInstall: Story = {
  async play({ canvas, userEvent }) {
    await userEvent.click(canvas.getByRole('button', { name: i18n.t('skills.open') }));
    await userEvent.click(canvas.getByRole('button', { name: i18n.t('skills.generate') }));
    const command = await canvas.findByLabelText<HTMLTextAreaElement>(i18n.t('skills.command'));
    await expect(command.value).toContain('npx --yes');
    await expect(canvas.getByText(i18n.t('skills.limits'))).not.toBeVisible();
    await userEvent.click(canvas.getByText(i18n.t('skills.memberCount', { count: 2 })));
    await expect(canvas.getByText('SQLの実行計画を診断する')).toBeVisible();
    await userEvent.click(canvas.getByText(i18n.t('skills.memberCount', { count: 2 })));
    await userEvent.click(canvas.getByText(i18n.t('skills.details')));
    await expect(canvas.getByText(i18n.t('skills.limits'))).toBeVisible();
    await userEvent.click(canvas.getByText(i18n.t('skills.details')));
  },
};
export const Mobile: Story = { ...GenerateAndInstall, globals: { viewport: { value: 'mobile', isRotated: false } } };

export const EnglishMobile: Story = { ...GenerateAndInstall, globals: { locale: 'en', viewport: { value: 'mobile', isRotated: false } } };
export const Interrupted: Story = {
  parameters: { api: { trpc: [
    trpcMutation('skills.start', () => success({ ...publishedSkillSet, stage: 'planning', members: [] })),
    trpcMutation('skills.advance', () => failure('The provider was interrupted. Saved progress is available.', 500)),
  ] } },
  async play({ canvas, userEvent }) {
    await userEvent.click(canvas.getByRole('button', { name: i18n.t('skills.open') }));
    await userEvent.click(canvas.getByRole('button', { name: i18n.t('skills.generate') }));
    await expect(await canvas.findByRole('button', { name: i18n.t('skills.resume') })).toBeVisible();
    await expect(canvas.queryByLabelText(i18n.t('skills.command'))).not.toBeInTheDocument();
  },
};

export const BeforeGeneration: Story = {
  async play({ canvas, userEvent }) {
    await userEvent.click(canvas.getByRole('button', { name: i18n.t('skills.open') }));
    await expect(canvas.getByRole('button', { name: i18n.t('skills.generate') })).toBeVisible();
    await expect(canvas.getByText(i18n.t('skills.generationCost'))).toBeVisible();
    await expect(canvas.getByText(i18n.t('skills.limits'))).not.toBeVisible();
  },
};
