import { fireEvent, render, screen } from '@testing-library/react'
import katex from 'katex'
import { applyChatPart, answerParts, plainChatAnswer, type ChatAnswer } from '@videoq/trpc/chat'
import { MessageBody } from '../MessageBody'
import { ChatMessageBubble } from '../ChatMessageBubble'
const source = { id: 1, video_id: 7, title: 'Video', start_time: '00:00:10', end_time: null }

describe('MessageBody', () => {
  afterEach(() => vi.restoreAllMocks())
  it.each(['history', 'stream'])('collapses a long citation group from %s without losing any seek targets', mode => {
    const sources = Array.from({ length: 12 }, (_, i) => ({
      ...source, id: i + 1, start_time: `00:00:${String(i * 5).padStart(2, '0')},125`,
      end_time: `00:00:${String(i * 5).padStart(2, '0')},125`, evidence_type: 'visual' as const,
    }))
    const saved: ChatAnswer = { segments: [{ text: 'Several scenes.', sourceIds: sources.map(s => s.id) }], sources }
    const streamed: ChatAnswer = { segments: [], sources }
    for (const part of answerParts(saved)) applyChatPart(streamed, part)
    const navigate = vi.fn()
    render(<MessageBody answer={mode === 'history' ? saved : streamed} onVideoNavigate={navigate} />)

    const toggle = screen.getByRole('button', { expanded: false })
    expect(toggle).toHaveTextContent('12')
    expect(screen.getAllByRole('button')).toHaveLength(1)
    const panel = document.getElementById(toggle.getAttribute('aria-controls')!)!
    expect(panel).not.toBeVisible()
    fireEvent.click(toggle)
    expect(toggle).toHaveAttribute('aria-expanded', 'true')
    expect(panel).toBeVisible()
    expect(screen.getAllByRole('button')).toHaveLength(13)
    for (const s of sources) {
      fireEvent.click(screen.getByRole('button', { name: new RegExp(`Video ${s.start_time}$`) }))
      expect(navigate).toHaveBeenLastCalledWith(s.video_id, s.start_time)
    }
    fireEvent.click(toggle)
    expect(screen.getAllByRole('button')).toHaveLength(1)
    expect(panel).not.toBeVisible()
  })
  it('keeps small citation groups next to their own passages and counts only usable sources', () => {
    const sources = [source, { ...source, id: 2, start_time: '00:00:55' }, { ...source, id: 3, start_time: null }]
    const { container } = render(<MessageBody answer={{ segments: [
      { text: 'Meeting.', sourceIds: [1, 1, 3, 99] },
      { text: '\n\nEarth.', sourceIds: [2] },
    ], sources }} onVideoNavigate={vi.fn()} />)
    const buttons = screen.getAllByRole('button')
    expect(buttons).toHaveLength(2)
    expect(buttons[0]).not.toHaveAttribute('aria-expanded')
    expect(container.textContent).toBe('Meeting. (0:10)\n\nEarth. (0:55)')
  })
  it('shows only the timestamp for visual evidence and seeks to the actual sampled frame', () => {
    const navigate = vi.fn()
    render(<MessageBody answer={{ segments: [{ text: 'The graph rises.', sourceIds: [1] }], sources: [{ ...source, evidence_type: 'visual', start_time: '00:00:10,125', end_time: '00:00:10,125' }] }} onVideoNavigate={navigate} />)
    const button = screen.getByRole('button')
    expect(button).toHaveTextContent(/^\(0:10\)$/)
    expect(button).toHaveAttribute('aria-label', 'Video 00:00:10,125')
    fireEvent.click(button)
    expect(navigate).toHaveBeenCalledExactlyOnceWith(7, '00:00:10,125')
  })
  it.each(['history', 'stream'])('renders the same math, code and citation positions from %s', mode => {
    const saved: ChatAnswer = { segments: [
      { text: '$ x[01] $', sourceIds: [1] },
      { text: '~~~ $y$\n```js\nconst ticks = "```";\n[1]\n````\n$z$', sourceIds: [1] },
    ], sources: [source] }
    const streamed: ChatAnswer = { segments: [], sources: [source] }
    for (const part of answerParts(saved)) applyChatPart(streamed, part)
    const navigate = vi.fn()
    const { container } = render(<MessageBody answer={mode === 'history' ? saved : streamed} onVideoNavigate={navigate} />)
    expect(Array.from(container.querySelectorAll('annotation'), node => node.textContent)).toEqual([' x[01] ', 'y', 'z'])
    const buttons = screen.getAllByRole('button', { name: 'Video 00:00:10' })
    expect(buttons).toHaveLength(2)
    fireEvent.click(buttons[1])
    expect(navigate).toHaveBeenCalledExactlyOnceWith(7, '00:00:10')
    expect(container.textContent).toContain('const ticks = "```";\n[1]\n````')
  })
  it('treats all reference-like prose literally and drops unknown source links', () => {
    const { container } = render(<MessageBody answer={{ segments: [{ text: '[1] [99] [-1] [1.5] `a[1]` [1](url)', sourceIds: [1, 99] }], sources: [source] }} onVideoNavigate={vi.fn()} />)
    expect(screen.getAllByRole('button')).toHaveLength(1)
    expect(container.textContent).toContain('[1] [99] [-1] [1.5] `a[1]` [1](url)')
  })
  it('renders a matrix and normalizes millisecond timestamps', () => {
    const text = String.raw`回転行列: \[R = \begin{pmatrix}\cos\theta & -\sin\theta \\ \sin\theta & \cos\theta\end{pmatrix}\]`
    const { container } = render(<MessageBody answer={{ segments: [{ text, sourceIds: [1] }], sources: [{ ...source, start_time: '00:06:37,480', end_time: '00:07:47,900' }] }} onVideoNavigate={vi.fn()} />)
    expect(container.querySelector('.katex-display')).toBeInTheDocument()
    expect(container.querySelector('annotation')?.textContent).toContain('pmatrix')
    expect(screen.getByRole('button')).toHaveTextContent('(6:37-7:47)')
  })
  it('reuses unchanged math while text streams and updates changed formulas', () => {
    const renderMath = vi.spyOn(katex, 'renderToString')
    const props = { answer: plainChatAnswer('Formula: \\(a+b\\)'), onVideoNavigate: vi.fn() }
    const { container, rerender } = render(<MessageBody {...props} />)
    for (const suffix of ['', ' is', ' is explained', ' is explained here.']) {
      rerender(<MessageBody {...props} answer={plainChatAnswer('Formula: \\(a+b\\)' + suffix)} />)
      expect(renderMath).toHaveBeenCalledTimes(1)
    }
    rerender(<MessageBody {...props} answer={plainChatAnswer('Formula: \\[a-b\\]')} />)
    expect(renderMath).toHaveBeenCalledTimes(2)
    expect(container.querySelector('.katex-display')).toBeInTheDocument()
  })
  it('joins text segments without adding whitespace or breaking a split formula', () => {
    const { container } = render(<MessageBody answer={{ segments: [{ text: 'Hello  \\(a', sourceIds: [] }, { text: '+b\\)\n', sourceIds: [1] }], sources: [source] }} onVideoNavigate={vi.fn()} />)
    expect(container.querySelector('annotation')).toHaveTextContent('a+b')
    expect(container.textContent).toContain('Hello  ')
  })
})


// Assert the DOM as well as text: jsdom does not execute injected scripts by default.
const xssPayloads = [
  '<script>window.__xss = true</script>',
  '<img src=x onerror="window.__xss = true">',
  '<svg onload="window.__xss = true"></svg>',
  '</span><iframe srcdoc="<script>parent.__xss = true</script>"></iframe>',
  '[open](javascript:window.__xss=true)',
  '<a href="data:text/html,<script>alert(1)</script>">open</a>',
]
function expectInert(container: HTMLElement) {
  expect(container.querySelector('script,img,iframe,object,embed,a[href],form')).toBeNull()
  for (const element of container.querySelectorAll('*')) {
    expect(element.getAttributeNames().filter(name => /^on/i.test(name))).toEqual([])
  }
}

describe('untrusted chat content', () => {
  it.each(xssPayloads)('keeps a user question inert: %s', content => {
    const { container } = render(<ChatMessageBubble message={{ role: 'user', content }}
      isFeedbackUpdating={false} onVideoNavigate={vi.fn()} onFeedback={vi.fn()} />)
    expect(container.textContent).toBe(content)
    expectInert(container)
  })

  it.each(['history', 'stream'])('keeps AI text and citation titles inert in %s', mode => {
    const text = xssPayloads.join('\n')
    const answer: ChatAnswer = { segments: [{ text, sourceIds: [1] }],
      sources: [{ ...source, title: xssPayloads[1] }] }
    const streamed: ChatAnswer = { segments: [], sources: answer.sources }
    for (const part of answerParts(answer)) applyChatPart(streamed, part)
    const { container } = render(<MessageBody answer={mode === 'history' ? answer : streamed} onVideoNavigate={vi.fn()} />)
    expect(container.textContent).toContain(text)
    expect(screen.getByRole('button')).toHaveAttribute('title', `${xssPayloads[1]} 00:00:10`)
    expectInert(container)
  })

  it.each([
    String.raw`\href{javascript:alert(1)}{open}`,
    String.raw`\href{JaVaScRiPt:alert(1)}{open}`,
    String.raw`\url{javascript:alert(1)}`,
    String.raw`\includegraphics{https://attacker.invalid/tracker.png}`,
    String.raw`\htmlData{onmouseover=alert(1)}{hover}`,
    String.raw`\htmlClass{attacker}{text}`,
    String.raw`\text{</span><img src=x onerror=alert(1)>}`,
    String.raw`\invalid{</span><img src=x onerror=alert(1)>}`,
  ])('rejects active HTML and URLs from untrusted TeX: %s', tex => {
    const { container } = render(<MessageBody answer={plainChatAnswer(`\\(${tex}\\)`)} onVideoNavigate={vi.fn()} />)
    expect(container.querySelector('.katex')).toBeInTheDocument()
    expectInert(container)
    expect(container.querySelector('.attacker')).toBeNull()
  })
})
