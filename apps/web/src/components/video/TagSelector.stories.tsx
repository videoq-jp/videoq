import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState, type ComponentProps } from 'react';
import { expect, fn } from 'storybook/test';
import i18n from '@/i18n/config';
import { englishTags, longTag, manyTags, tags } from '../../../.storybook/fixtures/tags';
import { TagSelector } from './TagSelector';

function SelectorExample(args: ComponentProps<typeof TagSelector>) {
  const [selectedTagIds, setSelectedTagIds] = useState(args.selectedTagIds);
  return (
    <TagSelector
      {...args}
      selectedTagIds={selectedTagIds}
      onToggle={(id) => {
        args.onToggle(id);
        setSelectedTagIds((current) => current.includes(id) ? current.filter((tagId) => tagId !== id) : [...current, id]);
      }}
    />
  );
}

const meta = {
  title: 'Video/TagSelector',
  component: TagSelector,
  args: { tags, selectedTagIds: [], onToggle: fn(), onCreateNew: fn(), disabled: false },
  decorators: [(Story) => <div className="max-w-xl"><Story /></div>],
  render: (args) => <SelectorExample key={JSON.stringify([args.tags, args.selectedTagIds])} {...args} />,
} satisfies Meta<typeof TagSelector>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Unselected: Story = {};
export const NoTags: Story = { args: { tags: [] } };
export const MultipleSelected: Story = { args: { selectedTagIds: [1, 2] } };
export const ManyTags: Story = { args: { tags: manyTags, selectedTagIds: [100, 111, 125] } };
export const LongNames: Story = {
  args: { tags: [...tags, longTag], selectedTagIds: [longTag.id] },
  globals: { viewport: { value: 'mobile', isRotated: false } },
};
export const Disabled: Story = {
  args: { ...MultipleSelected.args, disabled: true },
  play: async ({ canvas, userEvent, args }) => {
    for (const button of canvas.getAllByRole('button')) await expect(button).toBeDisabled();
    for (const chip of canvas.getAllByRole('button').flatMap(button => Array.from(button.querySelectorAll('[data-slot=chip-label]')))) {
      await expect(getComputedStyle(chip).color).toBe('rgb(148, 148, 148)');
      await expect(getComputedStyle(chip).backgroundColor).toBe('rgb(242, 242, 242)');
    }
    await userEvent.click(canvas.getByRole('button', { name: args.tags[0].name }));
    await userEvent.keyboard(' ');
    await expect(args.onToggle).not.toHaveBeenCalled();
    await expect(args.onCreateNew).not.toHaveBeenCalled();
  },
};
export const WithoutCreateButton: Story = { args: { onCreateNew: undefined } };
export const KeyboardToggle: Story = {
  play: async ({ canvas, userEvent, args }) => {
    const first = canvas.getByRole('button', { name: args.tags[0].name });
    await userEvent.click(first);
    await expect(first).toHaveAttribute('aria-pressed', 'true');
    await expect(first).toHaveFocus();
    await userEvent.keyboard(' ');
    await expect(first).toHaveAttribute('aria-pressed', 'false');
    await userEvent.tab();
    const second = canvas.getByRole('button', { name: args.tags[1].name });
    await expect(second).toHaveFocus();
    await userEvent.keyboard('{Enter}');
    await expect(second).toHaveAttribute('aria-pressed', 'true');
    await expect(args.onToggle).toHaveBeenLastCalledWith(args.tags[1].id);
  },
};
export const CreateNew: Story = {
  args: { tags: [] },
  play: async ({ canvas, userEvent, args }) => {
    await userEvent.click(canvas.getByRole('button', { name: `+ ${i18n.t('tags.selector.createNew')}` }));
    await expect(args.onCreateNew).toHaveBeenCalledTimes(1);
  },
};
export const EnglishMobile: Story = {
  args: { tags: englishTags, selectedTagIds: [1, 2] },
  globals: { locale: 'en', viewport: { value: 'mobile', isRotated: false } },
};
