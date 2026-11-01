import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { TagManagementModal } from '../TagManagementModal'
import { useTags } from '@/hooks/useTags'
import enTranslation from '@/i18n/locales/en/translation.json'
import jaTranslation from '@/i18n/locales/ja/translation.json'

const i18nMock = vi.hoisted(() => ({
    language: 'en',
    t: vi.fn(),
    changeLanguage: vi.fn(),
}))

const lookupTranslation = (language: 'en' | 'ja', key: string): string | undefined => {
    const resources = { en: enTranslation, ja: jaTranslation }
    let current: unknown = resources[language]
    for (const segment of key.split('.')) {
        if (!current || typeof current !== 'object' || !(segment in current)) {
            return undefined
        }
        current = (current as Record<string, unknown>)[segment]
    }
    return typeof current === 'string' ? current : undefined
}

// Mock useTags
vi.mock('@/hooks/useTags', () => ({
    useTags: vi.fn(),
}))

// Mock useTranslation with the real translation resources so missing keys fall back like production.
vi.mock('react-i18next', () => ({
    useTranslation: () => ({
        t: i18nMock.t,
        i18n: {
            language: i18nMock.language,
            changeLanguage: i18nMock.changeLanguage,
        },
    }),
}))

// Mock Dialog components (since they might need Radix context which can be complex to test, or just rely on them working)
// Actually Radix primitives usually work in tests if we use standard queries. 
// But if issues arise, we can generic mock. For now, try without mocking Dialog.
// Wait, Dialog from shadcn/ui uses Radix, which usually requires a Portal. 
// If it fails, checking `render` output will tell.
// Safe bet: Mock the dialog if not testing accessibility specifically. 
// But let's try to test real interaction first as it gives better confidence.
// However, Radix Dialog renders into a portal, so `screen.getBy...` should find it.
// Issue: JS-DOM might not support Pointer events fully for Radix.
// Let's rely on `render` and `screen` and see.

describe('TagManagementModal', () => {
    const mockDeleteTag = vi.fn()
    const mockTags = [
        { id: 1, name: 'Tag 1', color: 'red', created_at: '2023-01-01' },
        { id: 2, name: 'Tag 2', color: 'green', created_at: '2023-01-02' },
    ]

    beforeEach(() => {
        vi.clearAllMocks()
        i18nMock.language = 'en'
        i18nMock.t.mockImplementation((key: string, defaultValue?: string) =>
            lookupTranslation(i18nMock.language, key) ?? defaultValue ?? key
        )
        i18nMock.changeLanguage.mockImplementation((language: 'en' | 'ja') => {
            i18nMock.language = language
        })
        mockDeleteTag.mockResolvedValue(undefined)
            ; (useTags as any).mockReturnValue({
                tags: mockTags,
                deleteTag: mockDeleteTag,
                deletingTagId: null,
            })
    })

    it('should render nothing when not open', () => {
        render(<TagManagementModal isOpen={false} onClose={vi.fn()} />)
        expect(screen.queryByText('Tag Management')).not.toBeInTheDocument()
    })

    it('should render tags list when open', () => {
        render(<TagManagementModal isOpen={true} onClose={vi.fn()} />)

        expect(screen.getByText('Manage Tags')).toBeInTheDocument()
        expect(screen.getByText('Review existing tags and remove tags you no longer need.')).toBeInTheDocument()
        expect(screen.getByText('Tag 1')).toBeInTheDocument()
        expect(screen.getByText('Tag 2')).toBeInTheDocument()
    })

    it('should render the description in Japanese locale', () => {
        i18nMock.language = 'ja'

        render(<TagManagementModal isOpen={true} onClose={vi.fn()} />)

        expect(screen.getByText('タグ管理')).toBeInTheDocument()
        expect(screen.getByText('既存のタグを確認し、不要になったタグを削除できます。')).toBeInTheDocument()
        expect(screen.queryByText('Review existing tags and remove tags you no longer need.')).not.toBeInTheDocument()
    })

    it('should define the management description in each locale resource', () => {
        expect(enTranslation.tags.management).toMatchObject({
            description: 'Review existing tags and remove tags you no longer need.',
        })
        expect(jaTranslation.tags.management).toMatchObject({
            description: '既存のタグを確認し、不要になったタグを削除できます。',
        })
    })

    it('should show no tags message when tags list is empty', () => {
        ; (useTags as any).mockReturnValue({
            tags: [],
            deleteTag: mockDeleteTag,
            deletingTagId: null,
        })

        render(<TagManagementModal isOpen={true} onClose={vi.fn()} />)

        expect(screen.getByText('No available tags')).toBeInTheDocument()
    })

    it('should show delete confirmation when trash icon is clicked', () => {
        render(<TagManagementModal isOpen={true} onClose={vi.fn()} />)

        const deleteButton = screen.getByTestId('delete-tag-1')
        fireEvent.click(deleteButton)

        expect(screen.queryByText('Confirm?')).not.toBeInTheDocument()
        expect(screen.getByTestId('confirm-delete-1')).toBeInTheDocument()
        expect(screen.getByTestId('cancel-delete-1')).toBeInTheDocument()
    })

    it('should delete tag when confirmed', async () => {
        render(<TagManagementModal isOpen={true} onClose={vi.fn()} />)

        fireEvent.click(screen.getByTestId('delete-tag-1'))
        fireEvent.click(screen.getByTestId('confirm-delete-1'))

        await waitFor(() => {
            expect(mockDeleteTag).toHaveBeenCalledWith(1)
            expect(screen.queryByTestId('confirm-delete-1')).not.toBeInTheDocument()
        })
    })

    it('should mark the confirm button busy and freeze the other delete controls while deleting', () => {
        const { rerender } = render(<TagManagementModal isOpen={true} onClose={vi.fn()} />)

        // Reveal the confirm/cancel pair first, the way a user reaches it.
        fireEvent.click(screen.getByTestId('delete-tag-1'))

        ; (useTags as any).mockReturnValue({
            tags: mockTags,
            deleteTag: mockDeleteTag,
            deletingTagId: 1,
        })
        rerender(<TagManagementModal isOpen={true} onClose={vi.fn()} />)

        const confirmButton = screen.getByTestId('confirm-delete-1')
        expect(confirmButton).toBeDisabled()
        expect(confirmButton).toHaveAttribute('aria-busy', 'true')
        // aria-busy alone would still pass if the spinner itself were dropped.
        expect(confirmButton.querySelector('.animate-spin')).toBeInTheDocument()
        // Cancelling mid-flight would swap the confirm UI back to the trash icon
        // and let the same tag be deleted twice.
        expect(screen.getByTestId('cancel-delete-1')).toBeDisabled()
        // Switching the confirm UI to another tag would orphan the spinner.
        expect(screen.getByTestId('delete-tag-2')).toBeDisabled()
    })

    it('should leave the delete controls enabled when no deletion is in flight', () => {
        render(<TagManagementModal isOpen={true} onClose={vi.fn()} />)

        fireEvent.click(screen.getByTestId('delete-tag-1'))

        const confirmButton = screen.getByTestId('confirm-delete-1')
        expect(confirmButton).not.toBeDisabled()
        expect(confirmButton).not.toHaveAttribute('aria-busy', 'true')
        expect(screen.getByTestId('cancel-delete-1')).not.toBeDisabled()
        expect(screen.getByTestId('delete-tag-2')).not.toBeDisabled()
    })

    it('should surface a tag operation error outside the scrollable list', () => {
        ; (useTags as any).mockReturnValue({
            tags: mockTags,
            deleteTag: mockDeleteTag,
            deletingTagId: null,
            error: 'Failed to delete tag',
        })

        const { container } = render(<TagManagementModal isOpen={true} onClose={vi.fn()} />)

        const alert = screen.getByRole('alert')
        expect(alert).toHaveTextContent('Failed to delete tag')
        // The tag list scrolls; an error placed inside it would be unreachable
        // once the user has scrolled down to the tag they acted on.
        const scrollArea = container.querySelector('.overflow-y-auto')
        expect(scrollArea).not.toBeNull()
        expect(scrollArea!.contains(alert)).toBe(false)
    })

    it('should not render an alert when there is no error', () => {
        render(<TagManagementModal isOpen={true} onClose={vi.fn()} />)

        expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    })

    it('should cancel delete when cancel is clicked', () => {
        render(<TagManagementModal isOpen={true} onClose={vi.fn()} />)

        fireEvent.click(screen.getByTestId('delete-tag-1'))
        fireEvent.click(screen.getByTestId('cancel-delete-1'))

        expect(screen.queryByText('Confirm?')).not.toBeInTheDocument()
        expect(mockDeleteTag).not.toHaveBeenCalled()
    })

    it('focuses cancel when asking to delete and restores the original button on cancellation', () => {
        render(<TagManagementModal isOpen onClose={vi.fn()} />)
        fireEvent.click(screen.getByTestId('delete-tag-1'))
        expect(screen.getByTestId('cancel-delete-1')).toHaveFocus()
        fireEvent.click(screen.getByTestId('cancel-delete-1'))
        expect(screen.getByRole('button', { name: 'Delete: Tag 1' })).toHaveFocus()
    })

    it('closes the native dialog and clears the confirmation before reopening', () => {
        const onClose = vi.fn()
        const { rerender } = render(<TagManagementModal isOpen onClose={onClose} />)
        fireEvent.click(screen.getByTestId('delete-tag-1'))
        const dialog = screen.getByRole<HTMLDialogElement>('dialog')
        fireEvent.click(screen.getByRole('button', { name: 'Close' }))
        expect(dialog.open).toBe(false)
        expect(onClose).toHaveBeenCalledTimes(1)
        rerender(<TagManagementModal isOpen={false} onClose={onClose} />)
        rerender(<TagManagementModal isOpen onClose={onClose} />)
        expect(screen.queryByTestId('confirm-delete-1')).not.toBeInTheDocument()
    })

    it('focuses a deletion error outside the list after the pending state ends', () => {
        const { rerender } = render(<TagManagementModal isOpen onClose={vi.fn()} />)
        fireEvent.click(screen.getByTestId('delete-tag-1'))
        vi.mocked(useTags).mockReturnValue({ tags: mockTags, deleteTag: mockDeleteTag, deletingTagId: null, error: 'Failed to delete tag' } as ReturnType<typeof useTags>)
        rerender(<TagManagementModal isOpen onClose={vi.fn()} />)
        expect(screen.getByRole('alert').closest('[tabindex="-1"]')).toHaveFocus()
        expect(screen.getByTestId('confirm-delete-1')).toBeEnabled()
    })
})
