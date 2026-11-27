import { useState, type ComponentProps } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn, within, waitFor } from 'storybook/test';
import type { RpcOutputMap } from '@videoq/trpc';
import i18n from '@/i18n/config';
import { Button } from '@/components/ui/button';
import { CourseSkillsDialog } from './CourseSkillsDialog';
import { trpcHandler, trpcQuery, trpcMutation, success, failure } from '../../../../.storybook/mocks/network';

function handler(mode: 'normal' | 'removed' | 'error' = 'normal') {
  const detail: RpcOutputMap['courseSkills.get'] = {
    id: 'candidate-1', skillId: 'skill-1', contentHash: 'a'.repeat(64), status: mode === 'removed' ? 'published' : 'review_required', issues: [],
    draft: { slug: 'review-retry', title: '再試行と冪等性を確認する', description: '同じ処理が複数回実行される可能性があるとき、既存の保証を調べてから再試行を実装する。', useWhen: ['キューの再配送や一時エラーの再試行を設計する'], doNotUseWhen: ['別の業務上の再試行方針が定められている'], criteria: [{ decision: '同じ要求を識別する仕組みがあるかを確認する', factIds: ['fact-1'] }], steps: [{ action: '既存の重複判定と処理済み結果の保存方法を調べる', expectedResult: '重複実行が起きる条件と、現在の保証を説明できる', factIds: ['fact-1'] }], exceptions: [], checks: [{ check: '同じ要求を二回渡しても、副作用が一度だけ実行されることを確かめる', factIds: ['fact-1'] }], examples: [] },
    previousDraft: null, files: [], sources: [{ factId: 'fact-1', claim: '再試行する前に、重複実行に対する保証を確認する', videoId: 42, startMs: 500000, endMs: 545000, quote: '同じメッセージがもう一度届く可能性があります。処理済みかどうかを識別できるようにしましょう。' }],
  };
  const data: RpcOutputMap['courseSkills.list'] = { settings: { generationEnabled: true, distributionEnabled: true, policyVersion: '1', language: 'ja' }, revision: 3,
    candidates: [{ id: detail.id, skillId: detail.skillId, title: detail.draft!.title, description: detail.draft!.description, status: detail.status, contentHash: detail.contentHash, issues: [], hasDraft: true, editable: mode !== 'removed', canPublish: mode !== 'removed', publication: mode === 'removed' ? { id: 'publication', state: 'active', validSources: false } : null }],
    jobs: [{ id: 'build', revision: 3, state: 'completed', phase: 'review_required', processedVideos: 3, totalVideos: 3, error: null }],
  };
  return trpcHandler([
    trpcQuery('courseSkills.list', () => mode === 'error' ? failure('Skillsの状態を取得できませんでした') : success(data)),
    trpcQuery('courseSkills.get', () => success(detail)),
    trpcMutation('courseSkills.configure', input => { data.settings = input.settings; return success({ success: true as const }); }),
    trpcMutation('courseSkills.rebuild', () => success({ success: true as const })),
    trpcMutation('courseSkills.update', input => { detail.draft = input.draft; detail.contentHash = 'b'.repeat(64); data.candidates[0].contentHash = detail.contentHash; data.candidates[0].title = input.draft.title; return success({ success: true as const }); }),
    trpcMutation('courseSkills.publish', () => { detail.status = 'published'; data.candidates[0].status = 'published'; data.candidates[0].canPublish = false; data.candidates[0].publication = { id: 'publication', state: 'active', validSources: true }; return success({ revisionId: 'publication' }); }),
    trpcMutation('courseSkills.reject', () => { detail.status = 'rejected'; data.candidates[0].status = 'rejected'; data.candidates[0].canPublish = false; return success({ success: true as const }); }),
    trpcMutation('courseSkills.withdraw', () => { data.candidates[0].publication = { id: 'publication', state: 'revoked', validSources: false }; return success({ success: true as const }); }),
  ]);
}
function Example(args: ComponentProps<typeof CourseSkillsDialog>) {
  const [open, setOpen] = useState(args.isOpen);
  return <><Button onClick={() => setOpen(true)}>{i18n.t('courseSkills.title')}</Button><CourseSkillsDialog {...args} isOpen={open} onOpenChange={value => { args.onOpenChange(value); setOpen(value); }} /></>;
}
const meta = {
  title: 'Video/CourseSkillsDialog', component: CourseSkillsDialog,
  args: { courseId: 7, isOpen: false, onOpenChange: fn(), onPlay: fn() },
  render: args => <Example {...args} />,
  beforeEach({ parameters, msw }) { msw.use(handler(parameters.skillsMode as 'normal' | 'removed' | 'error' | undefined)); },
  async play({ canvas, userEvent }) {
    await userEvent.click(canvas.getByRole('button', { name: i18n.t('courseSkills.title') }));
    const dialog = within(await canvas.findByRole('dialog'));
    await dialog.findByText(i18n.t('courseSkills.skills'));
  },
} satisfies Meta<typeof CourseSkillsDialog>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Default: Story = {};
export const ReviewAndPublish: Story = {
  async play(context) {
    await meta.play(context);
    const dialog = within(context.canvas.getByRole('dialog'));
    await context.userEvent.click(dialog.getByRole('button', { name: i18n.t('courseSkills.review') }));
    const title = await dialog.findByRole('textbox', { name: i18n.t('courseSkills.name') });
    await context.userEvent.clear(title);
    await context.userEvent.type(title, '再試行の前提と検証を確認する');
    await expect(dialog.getByRole('button', { name: i18n.t('courseSkills.publish') })).toBeDisabled();
    await context.userEvent.click(dialog.getByRole('button', { name: i18n.t('courseSkills.save') }));
    await waitFor(() => expect(dialog.getByRole('button', { name: i18n.t('courseSkills.publish') })).toBeEnabled(), { timeout: 10000 });
    await context.userEvent.click(dialog.getByRole('button', { name: i18n.t('courseSkills.publish') }));
    await dialog.findByText(i18n.t('courseSkills.states.active'));
    await waitFor(() => expect(dialog.getByRole('textbox', { name: i18n.t('courseSkills.name') })).toBeDisabled());
  },
};
export const SourceRemoved: Story = { parameters: { skillsMode: 'removed' } };
export const LoadError: Story = { parameters: { skillsMode: 'error' }, async play({ canvas, userEvent }) { await userEvent.click(canvas.getByRole('button', { name: i18n.t('courseSkills.title') })); await canvas.findByText('Skillsの状態を取得できませんでした'); } };
export const EnglishMobile: Story = { globals: { locale: 'en', viewport: { value: 'mobile', isRotated: false } } };
