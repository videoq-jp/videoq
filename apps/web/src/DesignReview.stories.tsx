import { useState, type ReactNode } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within } from 'storybook/test';
import { useTranslation } from 'react-i18next';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { Checkbox } from '@/components/ui/checkbox';
import { Button } from '@/components/ui/button';
import { Link } from '@/components/ui/link';
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from '@/components/ui/select';
import { InlineLoading } from '@/components/common/InlineLoading';
import { InlineSpinner } from '@/components/common/InlineSpinner';
import { MessageAlert } from '@/components/common/MessageAlert';
import { CourseSharingNotice } from '@/components/video/course-detail/CourseSharingNotice';
import { TagSelector } from '@/components/video/TagSelector';
import { TagBadge } from '@/components/video/TagBadge';
import { ViewerActionsMenu } from '@/components/video/ViewerActionsMenu';
import { MenuList, MenuListItem, MenuListItemButton } from '@/components/ui/menu-list';
import { ChatProgressView } from '@/components/chat/ChatProgressView';
import { MessageBody } from '@/components/chat/MessageBody';
import { FeedbackProvider } from '@/components/common/FeedbackProvider';
import { useToast } from '@/components/common/feedback';
import { tags, englishTags } from '../.storybook/fixtures/tags';

function DesignReview() {
  const { i18n } = useTranslation();
  const copy = (ja: string, en: string) => i18n.language === 'en' ? en : ja;
  const [selected, setSelected] = useState<number[]>([2]);
  const [removed, setRemoved] = useState(false);
  const [checked, setChecked] = useState(true);
  const [course, setCourse] = useState('algebra');
  const toast = useToast();
  const section = (id: string, title: string, description: string, children: ReactNode, stories: [string, string][]) => (
    <section aria-labelledby={id} className="space-y-4 border-t border-solid-gray-420 py-6">
      <h2 id={id} className="text-std-24B-150">{title}</h2>
      <p className="text-std-17N-170 text-solid-gray-700">{description}</p>
      {children}
      <ul className="flex flex-wrap gap-x-6 gap-y-3 text-dns-14N-130">
        {stories.map(([id, label]) => <li key={id}><Link href={`/?path=/story/${id}`} target="_blank">{label}</Link></li>)}
      </ul>
    </section>
  );
  return <main className="mx-auto max-w-5xl px-6 py-8 text-solid-gray-800">
    <h1 className="mb-4 text-std-32B-150">{copy('デザインシステム修正レビュー', 'Design system improvements')}</h1>
    <p className="mb-6 text-std-17N-170">{copy('操作できる修正後の部品と、対象画面へのリンクです。Tabキーでフォーカス表示も確認できます。', 'Try the updated controls and open their screens below. Use Tab to inspect keyboard focus.')}</p>
    {section('review-fields', copy('1. 入力欄・選択欄・無効状態', '1. Fields, selection and disabled states'), copy('無効な入力欄は薄い背景・文字・枠で区別。選択欄とチェックボックスも共通部品に統一しました。', 'Disabled fields have muted backgrounds, text and borders. Selects and checkboxes use shared components.'),
      <div className="grid gap-6 sm:grid-cols-2">
        <div className="space-y-2"><Label htmlFor="review-enabled">{copy('通常の入力欄', 'Enabled field')}</Label><Input id="review-enabled" defaultValue={copy('線形代数', 'Linear algebra')} className="w-full" /></div>
        <div className="space-y-2"><Label htmlFor="review-disabled">{copy('無効な入力欄', 'Disabled field')}</Label><Input id="review-disabled" defaultValue={copy('線形代数', 'Linear algebra')} disabled className="w-full" /></div>
        <div className="space-y-2"><Label htmlFor="review-edit">{copy('編集欄（Tabで枠を確認）', 'Editor (Tab to inspect focus)')}</Label><Textarea id="review-edit" defaultValue={copy('回転行列の講義です。', 'A lecture on rotation matrices.')} rows={3} /></div>
        <div className="space-y-2"><Label htmlFor="review-disabled-textarea">{copy('無効な編集欄', 'Disabled editor')}</Label><Textarea id="review-disabled-textarea" defaultValue={copy('保存しています…', 'Saving…')} disabled rows={3} /></div>
        <div className="space-y-2"><Label htmlFor="review-course">{copy('利用する講座', 'Course')}</Label><Select value={course} onValueChange={setCourse}><SelectTrigger id="review-course" blockSize="md" className="w-full"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="algebra">{copy('線形代数', 'Linear algebra')}</SelectItem><SelectItem value="calculus">{copy('微分積分', 'Calculus')}</SelectItem></SelectContent></Select></div>
        <div className="flex flex-wrap items-center gap-6"><label className="flex min-h-11 items-center gap-2"><Checkbox checked={checked} onCheckedChange={v => setChecked(v === true)} />{copy('有効', 'Active')}</label><label className="flex min-h-11 items-center gap-2"><Checkbox checked disabled />{copy('変更不可', 'Locked')}</label></div>
      </div>, [['video-videouploadformfields--disabled', copy('アップロード・無効状態', 'Disabled upload form')], ['video-transcriptpanel--editing', copy('文字起こし編集', 'Transcript editor')], ['pages-teaching-connection--classroom', copy('授業連携', 'Teaching connection')], ['pages-admin--edit-user-layout', copy('管理画面', 'Admin')]])}
    {section('review-tags', copy('2. タグの可読性と操作領域', '2. Tag readability and controls'), copy('未選択でも文字を薄くせず、選択は塗りと枠で表現。削除ボタンの操作領域とフォーカス表示も改善しました。', 'Unselected labels remain readable. Fill and rings indicate selection; remove buttons have larger targets and shared focus.'),
      <div className="space-y-4"><TagSelector tags={i18n.language === 'en' ? englishTags : tags} selectedTagIds={selected} onToggle={id => setSelected(v => v.includes(id) ? v.filter(x => x !== id) : [...v, id])} />{!removed && <TagBadge tag={i18n.language === 'en' ? englishTags[0] : tags[0]} onRemove={() => setRemoved(true)} />}</div>, [['video-tagselector--unselected', copy('未選択タグ', 'Unselected tags')], ['video-tagfilterpanel--unselected', copy('タグフィルター', 'Tag filters')], ['video-tagcreatedialog--initial', copy('タグ色選択', 'Tag colors')]])}
    {section('review-loading', copy('3. 読み込み・処理中', '3. Loading and pending actions'), copy('トップ集計・チャット・ボタン内の回転表示を共通ProgressIndicatorへ統一。詳細の読み込み中に重複していた「一覧に戻る」も削除しました。', 'Counts, chat and pending buttons use the shared progress indicator. The duplicate back-to-list link was removed from detail loading.'),
      <div className="space-y-4"><InlineLoading /><Button disabled><InlineSpinner />{copy('保存中', 'Saving')}</Button><ChatProgressView progress={{ phase: 'searching', searches: [{ id: 1, query: copy('回転行列', 'Rotation matrices'), status: 'running' }] }} waitingForAnswer /></div>, [['pages-homedashboard--courses-loading', copy('トップ・集計の読み込み', 'Home counts loading')], ['common-loadingspinner--video-detail-loading', copy('詳細の読み込み', 'Detail loading')], ['chat-chatpanel--initial', copy('チャット・履歴切り替え', 'Chat and history')], ['video-videouploadmodal--initial', copy('アップロード方式切り替え', 'Upload mode')]])}
    {section('review-notices', copy('4. 通知と外部リンク', '4. Notifications and external links'), copy('連携・Q&A・チャット復元のエラーを共通バナーへ統一。通知を閉じるボタンと外部リンクの状態表示も揃えました。', 'Connection, Q&A and chat restoration errors use shared banners. Toast dismissal and external links share interaction states.'),
      <div className="space-y-4"><MessageAlert type="error" message={copy('接続できませんでした。もう一度お試しください。', 'Could not connect. Please try again.')} /><MessageAlert type="success" role="status" message={copy('接続しました。元の授業画面に戻ってください。', 'Connected. Return to your class.')} /><Button variant="outline" onClick={() => toast({ message: copy('保存しました', 'Saved'), variant: 'success', durationMs: 0 })}>{copy('通知を表示', 'Show toast')}</Button><div><Link href="https://github.com/videoq-jp/videoq-moodle#installation" target="_blank">{copy('Moodle設定ガイド', 'Moodle setup guide')}</Link></div></div>, [['pages-teaching-connection--already-connected', copy('授業連携エラー', 'Teaching error')], ['pages-moodle-connection--failed', copy('Moodle接続エラー', 'Moodle error')], ['common-feedbackprovider--dismiss-with-keyboard', copy('通知をキーボードで閉じる', 'Dismiss toast with keyboard')], ['video-course-qa--load-error', copy('Q&A取得エラー', 'Q&A load error')]])}
    {section('review-type', copy('5. 文字組み・メニューの影', '5. Typography and menu elevation'), copy('回答の見出しを文字組みトークンへ変更し、操作メニューの影もテーマの定義を使うようにしました。', 'Answer headings use typography tokens and the actions menu uses the theme elevation token.'),
      <div className="space-y-4"><MessageBody answer={{ segments: [{ text: '# 回転行列\n\n## 座標変換\n\n### 具体例\n\nベクトルの長さを変えずに向きを変えます。', sourceIds: [] }], sources: [] }} onVideoNavigate={() => {}} /><div className="flex justify-end pb-16"><ViewerActionsMenu label={copy('操作メニュー', 'Actions')}><MenuList><MenuListItem><MenuListItemButton type="box" size="regular">{copy('編集する', 'Edit')}</MenuListItemButton></MenuListItem></MenuList></ViewerActionsMenu></div></div>, [['chat-messagebody--long-text', copy('回答の文字組み', 'Answer typography')], ['pages-screen-review--course', copy('講座・操作メニュー', 'Course actions')]])}
    {section('review-followup', copy('6. 開閉操作・講座の並べ替え・ランディング', '6. Disclosures, course ordering and landing page'), copy('説明の開閉を共通フォーカスと44pxの操作領域に統一。講座の並べ替えもキーボード対応のボタンに変更し、ランディングの文字組み・角丸・影・余白を共通ルールへ揃えました。', 'Disclosures and reorder handles share focus states and 44px targets. Landing typography, radii, elevation and spacing follow the shared system.'),
      <p className="text-std-17N-170">{copy('以下の実画面で、Tab・Enter・Spaceキーによる操作を確認できます。', 'Open the real controls below and try Tab, Enter and Space.')}</p>, [['review-disclosure-controls--keyboard', copy('3種類の開閉操作', 'Disclosure controls')], ['pages-course-ordering--preview', copy('講座の並べ替え', 'Course ordering')], ['pages-landing--japanese', copy('ランディング', 'Landing page')], ['pages-landing--mobile', copy('ランディング・モバイル', 'Landing on mobile')]])}
    {section('review-final-followup', copy('7. 動画の並べ替え・無効メニュー', '7. Video ordering and disabled menus'), copy('講座内の動画の並べ替えも44pxの操作領域と共通フォーカスに統一。無効メニューは透明度ではなく共通の文字色で区別します。セレクトの影と共有ページの文字組みもテーマに揃えました。', 'Video reorder handles have 44px targets and shared focus. Disabled menus use a shared text color; select elevation and shared-page typography use theme tokens.'),
      <MenuList><MenuListItem><MenuListItemButton type="box" size="regular" disabled>{copy('保存中は編集できません', 'Editing is unavailable while saving')}</MenuListItemButton></MenuListItem><MenuListItem><MenuListItemButton type="box" size="regular" disabled className="text-error-1 hover:bg-red-50">{copy('保存中は削除できません', 'Deletion is unavailable while saving')}</MenuListItemButton></MenuListItem></MenuList>,
      [['video-sortablevideoitem--unselected', copy('動画の並べ替え操作', 'Video reorder controls')], ['video-sortablevideoitem--keyboard-reorder', copy('キーボードで並べ替え', 'Keyboard reordering')], ['video-sortablevideoitem--saving-order', copy('順序の保存中', 'Saving order')]])}
    {section('review-text-tokens', copy('8. 複数行の文字組み', '8. Multiline typography'), copy('本文・通知は17px／行間170%、質問候補・共有の注記・管理画面の補足は16px／行間170%のトークンへ統一。文字起こしの選択中と集計の強調には太字トークンを使います。', 'Body text and notifications use 17px/170% tokens. Suggestions, sharing notices and admin details use 16px/170%; active transcript text and analytics emphasis use bold tokens.'),
      <div className="space-y-4"><CourseSharingNotice method="link" /><Button variant="outline" onClick={() => toast({ message: copy('変更を保存しました。講座の共有設定と動画の並び順が更新されました。内容を確認して学習を続けてください。', 'Changes saved. Course sharing and video order have been updated. Review the changes and continue learning.'), variant: 'success', durationMs: 0 })}>{copy('複数行の通知を表示', 'Show multiline notification')}</Button></div>,
      [['video-transcriptpanel--default', copy('文字起こし', 'Transcript')], ['chat-chatpanel--suggested-questions', copy('質問候補', 'Suggested questions')], ['pages-admin--user-directory-mobile', copy('管理画面・モバイル', 'Admin on mobile')], ['dashboard-analyticsdashboard--typical', copy('集計の強調', 'Analytics emphasis')]])}
    {section('review-tag-states', copy('9. タグの無効状態と作成エラー', '9. Disabled tags and creation errors'), copy('無効なタグと色選択は共通のグレーで表示。作成失敗時はダイアログ内にエラーを表示し、名前と色を保持して再試行できます。', 'Disabled tags and palette choices use shared gray colors. Creation errors appear inside the dialog, keeping the name and color for retry.'),
      <TagSelector tags={i18n.language === 'en' ? englishTags : tags} selectedTagIds={[1]} onToggle={() => {}} disabled />,
      [['video-tagselector--disabled', copy('無効なタグ選択', 'Disabled tag selection')], ['video-tagcreatedialog--creating', copy('作成中の色選択', 'Palette while creating')], ['video-tagcreatedialog--failure', copy('作成エラーの表示', 'Creation error')], ['video-tagcreatedialog--failure-mobile', copy('作成エラー・モバイル', 'Creation error on mobile')], ['video-tagcreatedialog--failure-then-retry', copy('失敗後に再試行', 'Retry after failure')], ['video-tagcreatedialog--failure-then-retry-english-mobile', copy('失敗・再試行の英語モバイル', 'Retry in English on mobile')]])}
  </main>;
}

const meta = {
  title: 'Review/Design system improvements', component: DesignReview,
  decorators: [(Story) => <FeedbackProvider><Story /></FeedbackProvider>],
  parameters: { layout: 'fullscreen', a11y: { test: 'error' } },
} satisfies Meta<typeof DesignReview>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Overview: Story = {
  globals: { locale: 'ja' },
  async play({ canvas, userEvent, canvasElement }) {
    const disabledMenu = canvas.getByRole('button', { name: '保存中は削除できません' });
    await expect(disabledMenu).toBeDisabled();
    await expect(getComputedStyle(disabledMenu).color).toBe('rgb(179, 179, 179)');
    await expect(getComputedStyle(disabledMenu).opacity).toBe('1');
    const disabled = canvas.getByLabelText('無効な入力欄');
    await expect(disabled).toBeDisabled();
    await expect(getComputedStyle(disabled).backgroundColor).toBe('rgb(242, 242, 242)');
    const disabledEditor = canvas.getByLabelText('無効な編集欄');
    await expect(disabledEditor).toBeDisabled();
    await expect(getComputedStyle(disabledEditor).backgroundColor).toBe('rgb(242, 242, 242)');
    const editor = canvas.getByLabelText('編集欄（Tabで枠を確認）');
    editor.focus();
    await userEvent.keyboard('{Tab}{Shift>}{Tab}{/Shift}');
    await expect(getComputedStyle(editor).outlineWidth).toBe('4px');
    const tagRegion = within(canvas.getByRole('region', { name: '2. タグの可読性と操作領域' }));
    const tag = tagRegion.getByRole('button', { name: '線形代数' });
    await expect(getComputedStyle(tag).opacity).toBe('1');
    await userEvent.click(tag);
    await expect(tag).toHaveAttribute('aria-pressed', 'true');
    await expect(canvasElement.scrollWidth).toBeLessThanOrEqual(canvasElement.clientWidth);
  },
};
export const Mobile: Story = { ...Overview, globals: { locale: 'ja', viewport: { value: 'mobile', isRotated: false } } };
export const EnglishMobile: Story = { globals: { locale: 'en', viewport: { value: 'mobile', isRotated: false } } };
