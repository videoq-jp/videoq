import { render, screen } from '@testing-library/react'
import SignupCheckEmailPage from '../SignupCheckEmailPage'

describe('SignupCheckEmailPage', () => {
  beforeEach(() => {
    globalThis.__setMockSearchParams('')
  })

  afterEach(() => {
    globalThis.__setMockLanguage('en')
  })

  it('should render page title', () => {
    render(<SignupCheckEmailPage />)

    expect(screen.getByText('auth.checkEmail.title')).toBeInTheDocument()
  })

  it('should render description', () => {
    render(<SignupCheckEmailPage />)

    expect(screen.getByText('auth.checkEmail.description')).toBeInTheDocument()
  })

  it('should render success alert', () => {
    render(<SignupCheckEmailPage />)

    expect(screen.getByText('auth.checkEmail.alert')).toBeInTheDocument()
  })

  it('should render help text', () => {
    render(<SignupCheckEmailPage />)

    expect(screen.getByText('auth.checkEmail.help')).toBeInTheDocument()
  })

  it('should render back to login link', () => {
    render(<SignupCheckEmailPage />)

    expect(screen.getByText('auth.checkEmail.backToLogin')).toBeInTheDocument()
  })

  it('should have centered layout', () => {
    render(<SignupCheckEmailPage />)

    const container = screen.getByText('auth.checkEmail.title').closest('div')
    expect(container).toBeInTheDocument()
  })

  it.each(['/pricing?interval=year', '/en/pricing?interval=month', '/course-invitations/example'])('preserves the requested destination when returning to login: %s', next => {
    globalThis.__setMockSearchParams(`?next=${encodeURIComponent(next)}`)
    render(<SignupCheckEmailPage />)
    const link = screen.getByRole('link', { name: 'auth.checkEmail.backToLogin' })
    expect(new URL(link.getAttribute('href')!, 'https://videoq.jp').searchParams.get('next')).toBe(next)
  })

  it.each(['https://example.org', '//example.org', '/\\example.org'])('drops an unsafe return destination: %s', next => {
    globalThis.__setMockSearchParams(`?next=${encodeURIComponent(next)}`)
    render(<SignupCheckEmailPage />)
    const link = screen.getByRole('link', { name: 'auth.checkEmail.backToLogin' })
    expect(new URL(link.getAttribute('href')!, 'https://videoq.jp').search).toBe('')
  })

})
