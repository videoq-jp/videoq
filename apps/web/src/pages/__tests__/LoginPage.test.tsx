import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import LoginPage from '../LoginPage'
import { apiClient } from '@/lib/api'
import { useI18nNavigate } from '@/lib/i18n'
import { authClient } from '@/lib/auth-client'
import { AuthProvider } from '@/components/auth/AuthProvider'
import { appQueryClient, createAppQueryClient } from '@/lib/queryClient'

let mockNavigate: ReturnType<typeof vi.fn>

vi.mock('@/lib/auth-client', () => ({
  AUTH_BASE_URL: 'http://localhost:8000',
  authClient: {
    getSession: vi.fn(() => Promise.resolve({ data: { user: { id: '1' } }, error: null })),
  },
}))

vi.mock('@/lib/api', () => ({
  apiClient: {
    login: vi.fn(),
    loginWithGoogle: vi.fn(() => Promise.resolve()),
    setUnauthorizedHandler: vi.fn(),
    logout: vi.fn(() => Promise.resolve()),
  },
}))

describe('LoginPage', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockNavigate = useI18nNavigate() as ReturnType<typeof vi.fn>
  })

  it('displays a rejected login without navigating and permits retry', async () => {
    vi.mocked(apiClient.login).mockRejectedValueOnce(new Error('Invalid credentials')).mockResolvedValue(undefined)
    render(<LoginPage />)
    fireEvent.change(screen.getByLabelText(/auth\.fields\.username\.label/), { target: { value: 'user' } })
    fireEvent.change(screen.getByLabelText(/auth\.fields\.password\.label/), { target: { value: 'password' } })
    fireEvent.click(screen.getByRole('button', { name: 'auth.login.submit' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Invalid credentials')
    expect(authClient.getSession).not.toHaveBeenCalled()
    expect(mockNavigate).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'auth.login.submit' }))
    await waitFor(() => expect(mockNavigate).toHaveBeenCalledExactlyOnceWith('/'))
    expect(screen.queryByText('Invalid credentials')).not.toBeInTheDocument()
    expect(apiClient.login).toHaveBeenCalledTimes(2)
  })

  afterEach(() => {
    globalThis.__setMockLanguage('en')
    globalThis.__setMockSearchParams('')
  })

  it('should render login form', () => {
    render(<LoginPage />)

    expect(screen.getByText('auth.login.title')).toBeInTheDocument()
    expect(screen.getByText('auth.login.submit')).toBeInTheDocument()
  })

  it('should render username and password fields', () => {
    render(<LoginPage />)

    expect(screen.getByLabelText(/auth\.fields\.username\.label/)).toBeInTheDocument()
    expect(screen.getByLabelText(/auth\.fields\.password\.label/)).toBeInTheDocument()
  })

  it('should render forgot password link', () => {
    render(<LoginPage />)

    const forgotLink = screen.getByText('auth.login.forgotPassword')
    expect(forgotLink).toBeInTheDocument()
  })

  it('should not render an inert stay signed in checkbox', () => {
    render(<LoginPage />)

    expect(screen.queryByText('auth.login.rememberMe')).not.toBeInTheDocument()
  })

  it('should render signup link', () => {
    render(<LoginPage />)

    expect(screen.getByText('auth.login.footerLink')).toBeInTheDocument()
  })

  it('should render Google sign-in and call loginWithGoogle', async () => {
    render(<LoginPage />)

    const googleButton = screen.getByText('auth.login.continueWithGoogle')
    expect(googleButton).toBeInTheDocument()
    fireEvent.click(googleButton)

    await waitFor(() => {
      expect(apiClient.loginWithGoogle).toHaveBeenCalledWith('/')
    })
  })

  it('preserves an invitation return path for Google sign-in and the signup link', async () => {
    globalThis.__setMockSearchParams('next=%2Fcourse-invitations%2Finvite-token')
    render(<LoginPage />)

    fireEvent.click(screen.getByText('auth.login.continueWithGoogle'))

    await waitFor(() => {
      expect(apiClient.loginWithGoogle).toHaveBeenCalledWith('/course-invitations/invite-token')
    })
    expect(screen.getByText('auth.login.footerLink').closest('a')).toHaveAttribute(
      'href',
      '/signup?next=%2Fcourse-invitations%2Finvite-token',
    )
  })

  it('shows an OAuth callback error from the query string', () => {
    globalThis.__setMockSearchParams('?error=unable_to_create_user')
    render(<LoginPage />)
    expect(screen.getByText('auth.login.oauthCallbackFailed')).toBeInTheDocument()
  })

  it.each([
    ['email_not_verified', 'auth.login.oauthEmailVerificationRequired'],
    ['account_not_linked', 'auth.login.oauthAccountNotLinked'],
  ])('explains the next step for %s', (error, message) => {
    globalThis.__setMockSearchParams(`?error=${error}`)
    render(<LoginPage />)
    expect(screen.getByRole('alert')).toHaveTextContent(message)
    expect(screen.queryByText('auth.login.oauthCallbackFailed')).not.toBeInTheDocument()
  })

  it('should call apiClient.login on submit', async () => {
    ;(apiClient.login as ReturnType<typeof vi.fn>).mockResolvedValue({})

    render(<LoginPage />)

    const usernameInput = screen.getByLabelText(/auth\.fields\.username\.label/)
    fireEvent.change(usernameInput, { target: { value: 'test' } })

    const passwordInput = screen.getByLabelText(/auth\.fields\.password\.label/)
    fireEvent.change(passwordInput, { target: { value: 'test123' } })

    const submitButton = screen.getByText('auth.login.submit')
    fireEvent.click(submitButton)

    await waitFor(() => {
      expect(apiClient.login).toHaveBeenCalledWith({ username: 'test', password: 'test123' })
    })
  })

  it('should navigate to home on successful login', async () => {
    ;(apiClient.login as ReturnType<typeof vi.fn>).mockResolvedValue({})

    render(<LoginPage />)

    const usernameInput = screen.getByLabelText(/auth\.fields\.username\.label/)
    fireEvent.change(usernameInput, { target: { value: 'test' } })

    const passwordInput = screen.getByLabelText(/auth\.fields\.password\.label/)
    fireEvent.change(passwordInput, { target: { value: 'test123' } })

    const submitButton = screen.getByText('auth.login.submit')
    fireEvent.click(submitButton)

    await waitFor(() => {
      expect(authClient.getSession).toHaveBeenCalled()
      expect(mockNavigate).toHaveBeenCalledWith('/')
    })
  })

  it('completes login when the session change replaces the previous account cache', async () => {
    const previousClient = createAppQueryClient()
    previousClient.setQueryData(['private-videos'], ['previous-user-video'])
    const content = <AuthProvider initialQueryClient={previousClient}><LoginPage /></AuthProvider>
    const view = render(content)
    vi.mocked(apiClient.login).mockResolvedValue()
    vi.mocked(authClient.getSession).mockImplementationOnce(async () => {
      globalThis.__setMockAuthSession({ user: { id: '2' } })
      view.rerender(<AuthProvider initialQueryClient={previousClient}><LoginPage /></AuthProvider>)
      return { data: { user: { id: '2' } }, error: null } as Awaited<ReturnType<typeof authClient.getSession>>
    })

    fireEvent.change(screen.getByLabelText(/auth\.fields\.username\.label/), { target: { value: 'newuser' } })
    fireEvent.change(screen.getByLabelText(/auth\.fields\.password\.label/), { target: { value: 'password12345' } })
    fireEvent.click(screen.getByText('auth.login.submit'))

    await waitFor(() => {
      expect(mockNavigate).toHaveBeenCalledWith('/')
      expect(appQueryClient).not.toBe(previousClient)
      expect(appQueryClient.getQueryData(['private-videos'])).toBeUndefined()
    })
  })



  describe('?next= redirect after login', () => {
    let originalLocation: Location
    let hrefSetter: ReturnType<typeof vi.fn>

    beforeEach(() => {
      originalLocation = window.location
      hrefSetter = vi.fn()
      Object.defineProperty(window, 'location', {
        configurable: true,
        value: new Proxy({ href: '' }, {
          set(target, prop, value) {
            if (prop === 'href') {
              hrefSetter(value)
              target.href = value
              return true
            }
            return false
          },
          get(target, prop) {
            return target[prop as keyof typeof target]
          },
        }),
      })
    })

    afterEach(() => {
      Object.defineProperty(window, 'location', {
        configurable: true,
        value: originalLocation,
      })
      globalThis.__setMockSearchParams('')
    })

    const submitLoginForm = async () => {
      ;(apiClient.login as ReturnType<typeof vi.fn>).mockResolvedValue({})
      render(<LoginPage />)
      fireEvent.change(screen.getByLabelText(/auth\.fields\.username\.label/), { target: { value: 'u' } })
      fireEvent.change(screen.getByLabelText(/auth\.fields\.password\.label/), { target: { value: 'p' } })
      fireEvent.click(screen.getByText('auth.login.submit'))
    }

    it('resumes the Better Auth authorize query after login', async () => {
      globalThis.__setMockSearchParams(
        '?client_id=abc&redirect_uri=https%3A%2F%2Fchatgpt.com%2Fconnector%2Foauth%2Fcb&response_type=code',
      )

      await submitLoginForm()

      await waitFor(() => {
        expect(hrefSetter).toHaveBeenCalledWith(
          '/api/auth/oauth2/authorize?client_id=abc&redirect_uri=https%3A%2F%2Fchatgpt.com%2Fconnector%2Foauth%2Fcb&response_type=code',
        )
      })
      expect(mockNavigate).not.toHaveBeenCalled()
    })

    it('redirects to the safe next path via full navigation', async () => {
      globalThis.__setMockSearchParams('?next=%2Fapi%2Foauth%2Fauthorize%3Fclient_id%3Dabc')

      await submitLoginForm()

      await waitFor(() => {
        expect(hrefSetter).toHaveBeenCalledWith('/api/oauth/authorize?client_id=abc')
      })
      expect(mockNavigate).not.toHaveBeenCalled()
    })

    it('ignores a protocol-relative next and falls back to home', async () => {
      globalThis.__setMockSearchParams('?next=%2F%2Fevil.com%2Fphish')

      await submitLoginForm()

      await waitFor(() => {
        expect(mockNavigate).toHaveBeenCalledWith('/')
      })
      expect(hrefSetter).not.toHaveBeenCalled()
    })

    it('ignores an absolute URL next and falls back to home', async () => {
      globalThis.__setMockSearchParams('?next=https%3A%2F%2Fevil.com')

      await submitLoginForm()

      await waitFor(() => {
        expect(mockNavigate).toHaveBeenCalledWith('/')
      })
      expect(hrefSetter).not.toHaveBeenCalled()
    })

    it.each(['/\t/evil.example', '/\n/evil.example', '/\r/evil.example', '/\t\\evil.example'])(
      'rejects a next path that URL parsing converts to an external origin: %j',
      async (next) => {
        globalThis.__setMockSearchParams(`next=${encodeURIComponent(next)}`)

        await submitLoginForm()

        await waitFor(() => {
          expect(mockNavigate).toHaveBeenCalledWith('/')
        })
        expect(hrefSetter).not.toHaveBeenCalled()
      },
    )
  })

})
