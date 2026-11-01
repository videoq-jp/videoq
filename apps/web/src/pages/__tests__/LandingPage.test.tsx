import { render, screen } from '@testing-library/react'
import LandingPage from '../LandingPage'

describe('LandingPage', () => {
  it('renders the product heading, not a login heading', () => {
    render(<LandingPage />)

    expect(screen.getByRole('heading', { level: 1, name: /landing\.title.*landing\.titleAccent/ })).toBeInTheDocument()
    expect(screen.queryByText('auth.login.title')).not.toBeInTheDocument()
  })

  it('links to signup, login, and pricing', () => {
    render(<LandingPage />)

    expect(screen.getAllByRole('link', { name: 'landing.start' })[0]).toHaveAttribute('href', '/signup')
    expect(screen.getByRole('link', { name: 'landing.login' })).toHaveAttribute('href', '/login')
    expect(screen.getByRole('link', { name: /landing\.next\.pricing\.title/ })).toHaveAttribute(
      'href',
      '/pricing',
    )
  })

  it('links to the no-signup sample course instead of embedding a chat', () => {
    const { container } = render(<LandingPage />)

    expect(screen.getByRole('heading', { level: 2, name: 'landing.film.title' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'landing.film.play' })).toBeInTheDocument()
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
    expect(screen.getAllByRole('link', { name: 'landing.tryDemo' })[0]).toHaveAttribute('href', '/try')
    expect(screen.getByRole('list', { name: 'landing.film.stepsLabel' }).children).toHaveLength(4)
    expect(screen.getAllByRole('link', { name: 'landing.tryOwn' })[0]).toHaveAttribute('href', '/signup')
    expect(container.innerHTML).not.toContain('/share/')
    expect(container.textContent).not.toMatch(/yobinori|aicia|ヨビノリ/i)
  })

  it('does not mention a public repository or society journal', () => {
    const { container } = render(<LandingPage />)
    expect(container.textContent).not.toMatch(/github/i)
    expect(container.textContent).not.toMatch(/情報処理学会|ipsj/i)
  })
})
