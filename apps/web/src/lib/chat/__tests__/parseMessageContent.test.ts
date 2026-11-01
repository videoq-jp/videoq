import { describe, expect, it } from 'vitest'
import { parseChatText } from '@videoq/trpc/chat'
import { parseMessageContent } from '../parseMessageContent'
const parse = (text: string) => parseMessageContent([{ text, sourceIds: [] }])

describe('structured text and math rendering', () => {
  it.each([
    ['回転行列の説明 [1]', [{ type: 'text', value: '回転行列の説明 [1]' }]],
    ['面積は $$a^{2}$$ で、辺は \\(a\\) です。', [
      { type: 'text', value: '面積は ' }, { type: 'math', value: 'a^{2}', display: true },
      { type: 'text', value: ' で、辺は ' }, { type: 'math', value: 'a', display: false }, { type: 'text', value: ' です。' },
    ]],
    ['コストは $100 で、$x$ を求めます。', [
      { type: 'text', value: 'コストは $100 で、' }, { type: 'math', value: 'x', display: false }, { type: 'text', value: ' を求めます。' },
    ]],
    ['途中まで \\[ a^2', [{ type: 'text', value: '途中まで \\[ a^2' }]],
    ['Let $ and then $$a^2$$', [{ type: 'text', value: 'Let $ and then ' }, { type: 'math', value: 'a^2', display: true }]],
    [String.raw`$x$\(y\)$$z$$\[w\]`, [
      { type: 'math', value: 'x', display: false }, { type: 'math', value: 'y', display: false },
      { type: 'math', value: 'z', display: true }, { type: 'math', value: 'w', display: true },
    ]],
    [String.raw`\[\frac{a\]b}{c} + d\]`, [{ type: 'math', value: String.raw`\frac{a\]b}{c} + d`, display: true }]],
    [String.raw`prefix \[a {b\] still text \(c\) [1]`, [
      { type: 'text', value: String.raw`prefix \[a {b\] still text ` }, { type: 'math', value: 'c', display: false }, { type: 'text', value: ' [1]' },
    ]],
    ['$ x[01] $ [2]', [{ type: 'math', value: ' x[01] ', display: false }, { type: 'text', value: ' [2]' }]],
  ])('preserves syntax and literal prose: %s', (text, nodes) => expect(parse(text)).toEqual(nodes))

  it('keeps line context across structural citations', () => {
    expect(parseMessageContent([
      { text: 'Before', sourceIds: [1] }, { text: '~~~ $x$ ', sourceIds: [2] },
    ])).toEqual([
      { type: 'text', value: 'Before' }, { type: 'refs', ids: [1] }, { type: 'text', value: '~~~ ' },
      { type: 'math', value: 'x', display: false }, { type: 'text', value: ' ' }, { type: 'refs', ids: [2] },
    ])
  })
  it('keeps deduplicated citation groups attached to their original passage', () => {
    expect(parseMessageContent([
      { text: 'Meeting.', sourceIds: [2, 3, 2] },
      { text: '\n\nEarth.', sourceIds: [4] },
    ])).toEqual([
      { type: 'text', value: 'Meeting.' }, { type: 'refs', ids: [2, 3] },
      { type: 'text', value: '\n\nEarth.' }, { type: 'refs', ids: [4] },
    ])
  })
  it('merges adjacent text segments before parsing expressions split between them', () => {
    const text = String.raw`\[a+b\] and $x[1]$`;
    for (let split = 0; split <= text.length; split++) {
      expect(parseMessageContent([
        { text: text.slice(0, split), sourceIds: [] }, { text: text.slice(split), sourceIds: [] },
      ])).toEqual(parseChatText(text));
    }
  })
  it.each([
    '```js\nx[1]\n````\n',
    '```js\nconst ticks = "```";\n$x[1]$\n```\n',
    'Use ``a```[1]`` then ',
    '~~~ts\n~~~not a closing fence [1]\n~~~\n',
  ])('keeps code literal and renders subsequent math: %s', code => {
    expect(parse(code + '$x$')).toEqual([{ type: 'text', value: code }, { type: 'math', value: 'x', display: false }])
  })
  it('does not interpret reference-like strings during partial rendering', () => {
    for (const text of ['[', '[1', '[1]', '$$x', '\\(y']) expect(parse(text)).toEqual([{ type: 'text', value: text }])
    expect(parse('$$x$$')).toEqual([{ type: 'math', value: 'x', display: true }])
  })
})
