import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Textarea } from '../textarea'

describe('Textarea', () => {
  it('should render textarea', () => {
    render(<Textarea />)
    
    const textarea = screen.getByRole('textbox')
    expect(textarea).toBeInTheDocument()
  })

  it('should display placeholder text', () => {
    render(<Textarea placeholder="Enter text" />)
    
    const textarea = screen.getByPlaceholderText('Enter text')
    expect(textarea).toBeInTheDocument()
  })

  it('should display value', () => {
    render(<Textarea value="Test value" onChange={() => {}} />)
    
    const textarea = screen.getByRole<HTMLTextAreaElement>('textbox')
    expect(textarea.value).toBe('Test value')
  })

  it('should call onChange when text is entered', async () => {
    const handleChange = vi.fn()
    const user = userEvent.setup()
    
    render(<Textarea onChange={handleChange} />)
    
    const textarea = screen.getByRole('textbox')
    await user.type(textarea, 'test')
    
    expect(handleChange).toHaveBeenCalled()
  })

  it('should be disabled when disabled prop is true', () => {
    render(<Textarea disabled={true} />)
    
    const textarea = screen.getByRole('textbox')
    expect(textarea).toBeDisabled()
  })

  it('should apply custom className', () => {
    const { container } = render(<Textarea className="custom-class" />)
    
    const textarea = container.querySelector('[data-slot="textarea"]')
    expect(textarea?.className).toContain('custom-class')
  })
})

