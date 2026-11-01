import { render, screen, fireEvent } from '@testing-library/react'
import { VideoUploadFormFields } from '../VideoUploadFormFields'

describe('VideoUploadFormFields', () => {
  const defaultProps = {
    title: '',
    description: '',
    isUploading: false,
    error: null,
    success: false,
    setTitle: vi.fn(),
    setDescription: vi.fn(),
    handleFileChange: vi.fn(),
  }

  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('shows the selected audio language and allows changing it', () => {
    const change = vi.fn()
    const { rerender } = render(<VideoUploadFormFields {...defaultProps} transcriptionLanguage="ja" setTranscriptionLanguage={change} />)
    const select = screen.getByRole('combobox')
    expect(select).toHaveValue('ja')
    fireEvent.change(select, { target: { value: 'en' } })
    expect(change).toHaveBeenLastCalledWith('en')
    fireEvent.change(select, { target: { value: 'auto' } })
    expect(change).toHaveBeenLastCalledWith('auto')
    rerender(<VideoUploadFormFields {...defaultProps} transcriptionLanguage="en" setTranscriptionLanguage={change} isUploading />)
    expect(screen.getByRole('combobox')).toBeDisabled()
  })

  it('should render form fields', () => {
    render(<VideoUploadFormFields {...defaultProps} />)
    
    expect(screen.getByLabelText(/videos.upload.fileLabel/)).toBeInTheDocument()
    expect(screen.getByLabelText(/videos.upload.titleLabel/)).toBeInTheDocument()
    expect(screen.getByLabelText(/videos.upload.descriptionLabel/)).toBeInTheDocument()
  })

  it('should call setTitle when title changes', () => {
    render(<VideoUploadFormFields {...defaultProps} />)
    
    const titleInput = screen.getByLabelText(/videos.upload.titleLabel/)
    fireEvent.change(titleInput, { target: { value: 'New Title' } })
    
    expect(defaultProps.setTitle).toHaveBeenCalledWith('New Title')
  })

  it('should call setDescription when description changes', () => {
    render(<VideoUploadFormFields {...defaultProps} />)
    
    const descriptionInput = screen.getByLabelText(/videos.upload.descriptionLabel/)
    fireEvent.change(descriptionInput, { target: { value: 'New Description' } })
    
    expect(defaultProps.setDescription).toHaveBeenCalledWith('New Description')
  })

  it('should call handleFileChange when file changes', () => {
    render(<VideoUploadFormFields {...defaultProps} />)
    
    const fileInput = screen.getByLabelText(/videos.upload.fileLabel/)
    const file = new File(['content'], 'test.mp4', { type: 'video/mp4' })
    fireEvent.change(fileInput, { target: { files: [file] } })
    
    expect(defaultProps.handleFileChange).toHaveBeenCalled()
  })

  it('should display error message', () => {
    render(<VideoUploadFormFields {...defaultProps} error="Upload failed" />)
    
    expect(screen.getByText('Upload failed')).toBeInTheDocument()
  })

  it('should display success message', () => {
    render(<VideoUploadFormFields {...defaultProps} success={true} />)
    
    expect(screen.getByText(/videos.upload.success/)).toBeInTheDocument()
  })

  it('should display warning message', () => {
    render(<VideoUploadFormFields {...defaultProps} warning="videos.upload.warning.tagsFailed" />)

    expect(screen.getByText(/videos.upload.warning.tagsFailed/)).toBeInTheDocument()
  })

  it('should disable inputs when uploading', () => {
    render(<VideoUploadFormFields {...defaultProps} isUploading={true} />)
    
    const fileInput = screen.getByLabelText(/videos.upload.fileLabel/)
    const titleInput = screen.getByLabelText(/videos.upload.titleLabel/)
    const descriptionInput = screen.getByLabelText(/videos.upload.descriptionLabel/)
    
    expect(fileInput).toBeDisabled()
    expect(titleInput).toBeDisabled()
    expect(descriptionInput).toBeDisabled()
  })

  it('should show cancel button when showCancelButton is true', () => {
    const onCancel = vi.fn()
    render(
      <VideoUploadFormFields
        {...defaultProps}
        showCancelButton={true}
        onCancel={onCancel}
      />
    )
    
    expect(screen.getByText(/common.actions.cancel/)).toBeInTheDocument()
  })

  it('should call onCancel when cancel button is clicked', () => {
    const onCancel = vi.fn()
    render(
      <VideoUploadFormFields
        {...defaultProps}
        showCancelButton={true}
        onCancel={onCancel}
      />
    )
    
    const cancelButton = screen.getByText(/common.actions.cancel/)
    fireEvent.click(cancelButton)
    
    expect(onCancel).toHaveBeenCalled()
  })

  it('should hide buttons when hideButtons is true', () => {
    render(<VideoUploadFormFields {...defaultProps} hideButtons={true} />)

    expect(screen.queryByText(/videos.upload.upload/)).not.toBeInTheDocument()
  })

  it('should render a progress bar while uploading with a known progress value', () => {
    render(<VideoUploadFormFields {...defaultProps} isUploading={true} progress={55} />)

    const progressBar = screen.getByRole('progressbar')
    expect(progressBar).toHaveAttribute('aria-valuenow', '55')
    expect(progressBar).toHaveAccessibleName('videos.upload.uploading')
    expect(progressBar.textContent).toBe('55%')
  })

  it('should round a fractional progress value consistently in the bar and the label', () => {
    render(<VideoUploadFormFields {...defaultProps} isUploading={true} progress={55.6} />)

    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '56')
    expect(screen.getByText('56%')).toBeInTheDocument()
  })

  it('should not render a progress bar when progress is not provided', () => {
    render(<VideoUploadFormFields {...defaultProps} isUploading={true} />)

    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument()
  })

  it('should not render a progress bar or a stray "0" when progress is still zero', () => {
    render(<VideoUploadFormFields {...defaultProps} isUploading={true} progress={0} />)

    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument()
    expect(screen.queryByText('0')).not.toBeInTheDocument()
  })

  it('should not render a progress bar when not uploading', () => {
    render(<VideoUploadFormFields {...defaultProps} isUploading={false} progress={55} />)

    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument()
  })

  it('should forward progress to the submit button', () => {
    render(<VideoUploadFormFields {...defaultProps} isUploading={true} progress={55} />)

    const button = screen.getByRole('button', { name: /videos.upload.uploading/ })
    expect(button.textContent).toContain('55')
  })
})
