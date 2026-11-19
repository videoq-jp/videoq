import { useState, type ComponentProps } from 'react';
import { DndContext, KeyboardSensor, PointerSensor, closestCenter, useSensor, useSensors } from '@dnd-kit/core';
import { SortableContext, arrayMove, sortableKeyboardCoordinates, verticalListSortingStrategy } from '@dnd-kit/sortable';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn, waitFor, within } from 'storybook/test';
import i18n from '@/i18n/config';
import { courseVideos, longText } from '../../../../.storybook/fixtures/detail';
import { SortableVideoItem } from './SortableVideoItem';

const reordered = fn();
const removeLabel = () => i18n.t('videos.courseDetail.removeFromCourse');
const dragLabel = (title: string) => `${i18n.t('videos.courses.dragHandle')}: ${title}`;
function Example(args: ComponentProps<typeof SortableVideoItem>) {
  const [videos, setVideos] = useState([args.video, ...courseVideos.slice(1)]);
  const [selected, setSelected] = useState<number | null>(args.isSelected ? args.video.id : null);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 8 } }), useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }));
  return <div data-testid="course-video-list" className="max-w-[420px] border border-solid-gray-200">
    <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={({ active, over }) => {
      if (over && active.id !== over.id) {
        const next = arrayMove(videos, videos.findIndex(item => item.id === active.id), videos.findIndex(item => item.id === over.id));
        setVideos(next); reordered(next.map(item => item.id));
      }
    }}><SortableContext items={videos.map(item => item.id)} strategy={verticalListSortingStrategy}>
      {videos.map(video => <div key={video.id} data-testid={`course-video-${video.id}`}><SortableVideoItem {...args} video={video} isSelected={selected === video.id} isRemoving={args.isRemoving && video.id === args.video.id}
        onSelect={id => { args.onSelect(id); setSelected(id); }} /></div>)}
    </SortableContext></DndContext>
  </div>;
}
const meta = {
  title: 'Video/SortableVideoItem', component: SortableVideoItem,
  args: { video: courseVideos[0], isSelected: false, isRemoving: false, isMutationPending: false, isMobile: false, canManage: true, onSelect: fn(), onRemove: fn() },
  render: args => <Example {...args} />,
  beforeEach() { reordered.mockClear(); },
} satisfies Meta<typeof SortableVideoItem>;
export default meta;
type Story = StoryObj<typeof meta>;
type Context = Parameters<NonNullable<Story['play']>>[0];
const row = (context: Context) => within(context.canvas.getByTestId(`course-video-${context.args.video.id}`));
async function startDrag(context: Context) { row(context).getByRole('button', { name: dragLabel(context.args.video.title) }).focus(); await context.userEvent.keyboard(' '); await waitFor(() => expect(context.canvas.getByTestId(`course-video-${context.args.video.id}`).firstElementChild).toHaveStyle({ opacity: '0.5' })); }
export const Unselected: Story = { async play(context) { await expect(row(context).getByRole('button', { pressed: false, name: new RegExp(context.args.video.title) })).toBeVisible(); const handle = row(context).getByRole('button', { name: dragLabel(context.args.video.title) }); await expect(handle.getBoundingClientRect().width).toBeGreaterThanOrEqual(44); await expect(handle.getBoundingClientRect().height).toBeGreaterThanOrEqual(44); } };
export const Selected: Story = { args: { isSelected: true }, async play(context) { await expect(row(context).getByRole('button', { pressed: true })).toBeVisible(); } };
export const SelectVideo: Story = { async play(context) { await context.userEvent.click(row(context).getByRole('button', { pressed: false })); await expect(context.args.onSelect).toHaveBeenCalledWith(context.args.video.id); await expect(row(context).getByRole('button', { pressed: true })).toHaveFocus(); } };
export const KeyboardSelect: Story = { async play(context) { row(context).getByRole('button', { name: dragLabel(context.args.video.title) }).focus(); await context.userEvent.tab(); await context.userEvent.keyboard('{Enter}'); await expect(context.args.onSelect).toHaveBeenCalledWith(context.args.video.id); await expect(row(context).getByRole('button', { pressed: true })).toHaveFocus(); } };
export const RemoveVideo: Story = { async play(context) { await context.userEvent.click(row(context).getByRole('button', { name: removeLabel() })); await expect(context.args.onRemove).toHaveBeenCalledWith(context.args.video.id); await expect(context.args.onSelect).not.toHaveBeenCalled(); } };
export const Removing: Story = { args: { isRemoving: true, isMutationPending: true }, async play(context) { const remove = row(context).getByRole('button', { name: removeLabel() }); await expect(remove).toHaveAttribute('aria-busy', 'true'); for (const button of context.canvas.getAllByRole('button', { name: removeLabel() })) await expect(button).toBeDisabled(); remove.parentElement!.click(); await expect(context.args.onSelect).not.toHaveBeenCalled(); await expect(row(context).getByRole('button', { name: dragLabel(context.args.video.title) })).toHaveAttribute('aria-disabled', 'true'); } };
export const OtherVideoRemoving: Story = { args: { isMutationPending: true }, async play(context) { await expect(row(context).getByRole('button', { name: removeLabel() })).toHaveAttribute('aria-busy', 'false'); await expect(row(context).getByRole('button', { name: removeLabel() })).toBeDisabled(); } };
export const SavingOrder: Story = {
  args: { isMutationPending: true },
  async play(context) {
    const handle = row(context).getByRole('button', { name: dragLabel(context.args.video.title) });
    await expect(handle).not.toBeDisabled();
    handle.focus();
    await context.userEvent.keyboard(" {ArrowDown} ");
    await expect(handle).toHaveFocus();
    await expect(handle).toHaveAttribute('aria-disabled', 'true');
    for (const button of context.canvas.getAllByRole('button', { name: removeLabel() })) {
      await expect(button).toBeDisabled();
      await expect(button).toHaveAttribute('aria-busy', 'false');
    }
    await context.userEvent.click(row(context).getByRole('button', { pressed: false }));
    await expect(context.args.onSelect).toHaveBeenCalledWith(context.args.video.id);
    await expect(reordered).not.toHaveBeenCalled();
  },
};
export const Member: Story = { args: { canManage: false }, async play(context) { await expect(context.canvas.queryByRole('button', { name: removeLabel() })).not.toBeInTheDocument(); await expect(context.canvas.queryByRole('button', { name: dragLabel(context.args.video.title) })).not.toBeInTheDocument(); await KeyboardSelectMember(context); } };
async function KeyboardSelectMember(context: Context) { row(context).getByRole('button', { pressed: false }).focus(); await context.userEvent.keyboard(' '); await expect(context.args.onSelect).toHaveBeenCalledWith(context.args.video.id); }
export const Dragging: Story = { async play(context) { await startDrag(context); await expect(context.args.onSelect).not.toHaveBeenCalled(); } };
export const KeyboardReorder: Story = { async play(context) { await startDrag(context); await context.userEvent.keyboard('{ArrowDown}'); await context.userEvent.keyboard(' '); await waitFor(() => expect(reordered).toHaveBeenCalledWith([8, 7, 9])); await expect(row(context).getByRole('button', { name: dragLabel(context.args.video.title) })).toHaveFocus(); } };
export const CancelDrag: Story = { async play(context) { await startDrag(context); await context.userEvent.keyboard('{ArrowDown}{Escape}'); await expect(reordered).not.toHaveBeenCalled(); await expect(context.canvas.getByTestId(`course-video-${context.args.video.id}`).firstElementChild).toHaveStyle({ opacity: '1' }); } };
export const LongTitleMobile: Story = { globals: { viewport: { value: 'mobile', isRotated: false } }, args: { isMobile: true, video: { ...courseVideos[0], title: longText } }, async play(context) { const frame = context.canvas.getByTestId('course-video-list'); await expect(frame.scrollWidth).toBeLessThanOrEqual(frame.clientWidth); await expect(row(context).getByRole('button', { pressed: false })).toHaveAttribute('title', longText); await expect(context.canvas.queryByRole('button', { name: dragLabel(context.args.video.title) })).not.toBeInTheDocument(); } };
export const EnglishMobile: Story = { globals: { locale: 'en', viewport: { value: 'mobile', isRotated: false } }, args: { isMobile: true, video: { ...courseVideos[0], title: 'Rotation matrices and coordinate transformations' } }, async play(context) { await KeyboardSelectMember(context); } };
