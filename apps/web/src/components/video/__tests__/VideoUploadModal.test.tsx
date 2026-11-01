import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { VideoUploadModal } from '../VideoUploadModal'
import { useVideoUpload } from '@/hooks/useVideoUpload'

vi.mock('@/hooks/useTags', () => ({
  useTags: vi.fn(() => ({
    tags: [],
    createTag: vi.fn(),
  })),
}))

vi.mock('@/hooks/useVideoUpload', () => ({
  useVideoUpload: vi.fn(),
}))

vi.mock('../VideoUploadFormFields', () => ({
  VideoUploadFormFields: (props: any) => (
    <div data-testid="file-fields" data-progress={props.progress}>file fields</div>
  ),
}))

describe('VideoUploadModal', () => {
  const baseHook = {
    file: null,
    title: '',
    description: '',
    youtubeUrl: '',
    sourceMode: 'file' as const,
    tagIds: [],
    isUploading: false,
    error: null,
    errorParams: {},
    warning: null,
    success: false,
    setTitle: vi.fn(),
    setDescription: vi.fn(),
    setYoutubeUrl: vi.fn(),
    setSourceMode: vi.fn(),
    setTagIds: vi.fn(),
    handleFileChange: vi.fn(),
    handleSubmit: vi.fn(),
    reset: vi.fn(),
  }

  beforeEach(() => {
    vi.clearAllMocks()
    ;(useVideoUpload as any).mockReturnValue(baseHook)
  })

  afterEach(() => { vi.useRealTimers() })

  it('disables source switching and prevents Escape while uploading', async () => {
    vi.mocked(useVideoUpload).mockReturnValue({ ...baseHook, progress: 46, isUploading: true })
    const onClose = vi.fn()
    render(<VideoUploadModal isOpen onClose={onClose} />)
    expect(screen.getByRole('button', { name: 'videos.upload.modes.file' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'videos.upload.modes.youtube' })).toBeDisabled()
    fireEvent(screen.getByRole('dialog'), new Event('cancel', { cancelable: true }))
    expect(onClose).not.toHaveBeenCalled()
    expect(baseHook.reset).not.toHaveBeenCalled()
  })

  it('closes the native dialog and resets exactly once after the default two seconds', async () => {
    vi.useFakeTimers()
    vi.mocked(useVideoUpload).mockReturnValue({ ...baseHook, progress: 100, success: true })
    const onClose = vi.fn()
    render(<VideoUploadModal isOpen onClose={onClose} />)
    const dialog = screen.getByRole<HTMLDialogElement>('dialog')
    await act(() => vi.advanceTimersByTime(1999))
    expect(onClose).not.toHaveBeenCalled()
    await act(() => vi.advanceTimersByTime(1))
    expect(dialog.open).toBe(false)
    expect(baseHook.reset).toHaveBeenCalledTimes(1)
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('keeps success open when auto close is disabled and permits manual close', async () => {
    vi.useFakeTimers()
    vi.mocked(useVideoUpload).mockReturnValue({ ...baseHook, progress: 100, success: true })
    const onClose = vi.fn()
    render(<VideoUploadModal isOpen onClose={onClose} autoCloseDelayMs={null} />)
    await act(() => vi.advanceTimersByTime(10000))
    expect(onClose).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'common.actions.cancel' }))
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('cancels the success timer when hidden or unmounted', async () => {
    vi.useFakeTimers()
    vi.mocked(useVideoUpload).mockReturnValue({ ...baseHook, progress: 100, success: true })
    const onClose = vi.fn()
    const { rerender, unmount } = render(<VideoUploadModal isOpen onClose={onClose} />)
    await act(() => vi.advanceTimersByTime(1000))
    rerender(<VideoUploadModal isOpen={false} onClose={onClose} />)
    await act(() => vi.advanceTimersByTime(2000))
    expect(onClose).not.toHaveBeenCalled()
    rerender(<VideoUploadModal isOpen onClose={onClose} />)
    unmount()
    await act(() => vi.advanceTimersByTime(2000))
    expect(onClose).not.toHaveBeenCalled()
  })

  it('handles a rejected upload without closing', async () => {
    const handleSubmit = vi.fn().mockRejectedValue(new Error('Upload failed'))
    vi.mocked(useVideoUpload).mockReturnValue({ ...baseHook, progress: 0, handleSubmit })
    const onClose = vi.fn()
    const { container } = render(<VideoUploadModal isOpen onClose={onClose} />)
    fireEvent.submit(container.querySelector('form')!)
    await waitFor(() => expect(handleSubmit).toHaveBeenCalledTimes(1))
    expect(onClose).not.toHaveBeenCalled()
    expect(screen.getByRole('dialog')).toBeInTheDocument()
  })

  it('shows file upload fields by default', async () => {
    render(<VideoUploadModal isOpen={true} onClose={vi.fn()} />)

    expect(screen.getByTestId('file-fields')).toBeInTheDocument()
    expect(screen.getByText('videos.upload.modes.file')).toBeInTheDocument()
    expect(screen.getByText('videos.upload.modes.youtube')).toBeInTheDocument()
  })

  it('switches to youtube mode when youtube tab is clicked', async () => {
    render(<VideoUploadModal isOpen={true} onClose={vi.fn()} />)

    fireEvent.click(screen.getByText('videos.upload.modes.youtube'))

    expect(baseHook.setSourceMode).toHaveBeenCalledWith('youtube')
  })

  it('renders youtube url input in youtube mode', async () => {
    ;(useVideoUpload as any).mockReturnValue({
      ...baseHook,
      sourceMode: 'youtube',
    })

    render(<VideoUploadModal isOpen={true} onClose={vi.fn()} />)

    expect(screen.getByLabelText(/videos\.upload\.youtubeUrlLabel/)).toBeInTheDocument()
    expect(screen.getByLabelText(/videos\.upload\.titleLabel/)).toBeInTheDocument()
    expect(screen.getByLabelText(/videos\.upload\.descriptionLabel/)).toBeInTheDocument()
  })

  it('renders upload warning in youtube mode', async () => {
    ;(useVideoUpload as any).mockReturnValue({
      ...baseHook,
      sourceMode: 'youtube',
      warning: 'videos.upload.warning.tagsFailed',
    })

    render(<VideoUploadModal isOpen={true} onClose={vi.fn()} />)

    expect(screen.getByText('videos.upload.warning.tagsFailed')).toBeInTheDocument()
  })

  it('passes the upload progress through to the file upload form fields', async () => {
    ;(useVideoUpload as any).mockReturnValue({
      ...baseHook,
      isUploading: true,
      progress: 77,
    })

    render(<VideoUploadModal isOpen={true} onClose={vi.fn()} />)

    expect(screen.getByTestId('file-fields')).toHaveAttribute('data-progress', '77')
  })

  it('shows the upload percentage on the submit button while uploading a file', async () => {
    ;(useVideoUpload as any).mockReturnValue({
      ...baseHook,
      isUploading: true,
      progress: 42,
    })

    render(<VideoUploadModal isOpen={true} onClose={vi.fn()} />)

    const submitButton = screen.getByRole('button', { name: /videos.upload.uploading/ })
    expect(submitButton.textContent).toContain('42')
  })

  it('does not show a percentage on the submit button in youtube mode', async () => {
    ;(useVideoUpload as any).mockReturnValue({
      ...baseHook,
      sourceMode: 'youtube',
      isUploading: true,
      progress: 0,
    })

    render(<VideoUploadModal isOpen={true} onClose={vi.fn()} />)

    // Guard that the youtube branch is really the one being rendered, otherwise
    // this assertion would hold for any mode simply because progress is 0.
    expect(screen.queryByTestId('file-fields')).not.toBeInTheDocument()

    const submitButton = screen.getByRole('button', { name: /videos.upload.uploading/ })
    expect(submitButton.textContent).not.toContain('uploadingWithProgress')
  })
})
