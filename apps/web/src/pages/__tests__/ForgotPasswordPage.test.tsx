import { render, screen, fireEvent, waitFor, act } from '@testing-library/react'
import ForgotPasswordPage from '../ForgotPasswordPage'
import { apiClient } from '@/lib/api'

vi.mock('@/lib/api', () => ({
  apiClient: {
    getMe: vi.fn(() => Promise.resolve({ id: '1', username: 'testuser', email: 'test@example.com' })),
    requestPasswordReset: vi.fn(),
  },
}))

describe('ForgotPasswordPage', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('should render page title', () => {
    render(<ForgotPasswordPage />)

    expect(screen.getByText('auth.forgotPassword.title')).toBeInTheDocument()
  })

  it('should render description', () => {
    render(<ForgotPasswordPage />)

    expect(screen.getByText('auth.forgotPassword.description')).toBeInTheDocument()
  })

  it('should render email input', () => {
    render(<ForgotPasswordPage />)

    expect(screen.getByText('auth.fields.email.label')).toBeInTheDocument()
    expect(screen.getByLabelText(/auth\.fields\.email\.label/)).toBeInTheDocument()
  })

  it('should render submit button', () => {
    render(<ForgotPasswordPage />)

    expect(screen.getByText('auth.forgotPassword.submit')).toBeInTheDocument()
  })

  it('should render back to login link', () => {
    render(<ForgotPasswordPage />)

    expect(screen.getByText('auth.forgotPassword.backToLogin')).toBeInTheDocument()
  })

  it('should call requestPasswordReset on submit', async () => {
    ; (apiClient.requestPasswordReset as ReturnType<typeof vi.fn>).mockResolvedValue({})

    render(<ForgotPasswordPage />)

    const emailInput = screen.getByLabelText(/auth\.fields\.email\.label/)
    fireEvent.change(emailInput, { target: { value: 'test@example.com' } })

    const submitButton = screen.getByText('auth.forgotPassword.submit')
    fireEvent.click(submitButton)

    await waitFor(() => {
      expect(apiClient.requestPasswordReset).toHaveBeenCalledWith({ email: 'test@example.com' })
    })
  })

  it('should show success message after successful submission', async () => {
    ; (apiClient.requestPasswordReset as ReturnType<typeof vi.fn>).mockResolvedValue({})

    render(<ForgotPasswordPage />)

    const emailInput = screen.getByLabelText(/auth\.fields\.email\.label/)
    fireEvent.change(emailInput, { target: { value: 'test@example.com' } })

    const submitButton = screen.getByText('auth.forgotPassword.submit')
    fireEvent.click(submitButton)

    await waitFor(() => {
      expect(screen.getByText('auth.forgotPassword.success')).toBeInTheDocument()
    })
  })

  it('should show loading state while submitting', async () => {
    let resolveRequest: (() => void) | undefined
    const pendingRequest = new Promise<void>((resolve) => {
      resolveRequest = resolve
    })
    ; vi.mocked(apiClient.requestPasswordReset).mockImplementation(
      () => pendingRequest
    )

    render(<ForgotPasswordPage />)

    const emailInput = screen.getByLabelText(/auth\.fields\.email\.label/)
    fireEvent.change(emailInput, { target: { value: 'test@example.com' } })

    const submitButton = screen.getByText('auth.forgotPassword.submit')
    fireEvent.click(submitButton)

    expect(await screen.findByText('auth.forgotPassword.submitting')).toBeInTheDocument()

    await act(async () => {
      resolveRequest?.()
      await pendingRequest
    })
  })

  it('shows the current request error and clears it after a successful retry', async () => {
    vi.mocked(apiClient.requestPasswordReset)
      .mockRejectedValueOnce(new Error('Service unavailable'))
      .mockRejectedValueOnce(new Error('Please wait before retrying'))
      .mockResolvedValue(undefined)
    render(<ForgotPasswordPage />)
    fireEvent.change(screen.getByLabelText(/auth\.fields\.email\.label/), { target: { value: 'test@example.com' } })
    const submit = () => fireEvent.click(screen.getByRole('button', { name: 'auth.forgotPassword.submit' }))
    submit()
    expect(await screen.findByRole('alert')).toHaveTextContent('Service unavailable')
    expect(screen.queryByText('auth.forgotPassword.success')).not.toBeInTheDocument()
    submit()
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Please wait before retrying'))
    expect(screen.queryByText('Service unavailable')).not.toBeInTheDocument()
    submit()
    expect(await screen.findByText('auth.forgotPassword.success')).toBeInTheDocument()
    expect(screen.queryByText('Please wait before retrying')).not.toBeInTheDocument()
    expect(apiClient.requestPasswordReset).toHaveBeenCalledTimes(3)
  })

  it('uses autofilled email and ignores repeated submissions while pending', async () => {
    let finish!: () => void
    vi.mocked(apiClient.requestPasswordReset).mockImplementation(() => new Promise(resolve => { finish = resolve }))
    render(<ForgotPasswordPage />)
    const input = screen.getByLabelText<HTMLInputElement>(/auth\.fields\.email\.label/)
    input.value = 'autofilled@example.com'
    const form = input.closest('form')!
    act(() => { fireEvent.submit(form); fireEvent.submit(form) })
    await waitFor(() => expect(apiClient.requestPasswordReset).toHaveBeenCalled())
    await act(async () => { finish() })
    expect(apiClient.requestPasswordReset).toHaveBeenCalledExactlyOnceWith({ email: 'autofilled@example.com' })
  })
})
