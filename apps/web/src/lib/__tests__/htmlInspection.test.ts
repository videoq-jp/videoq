import { describe, expect, it } from 'vitest';
// @ts-expect-error Build/audit helper is intentionally a Node-only ES module.
import { htmlText, rootText } from '../../../scripts/html-text.mjs';

describe('SEO HTML text inspection', () => {
  it('reads nested headings and decoded entities using HTML parsing', () => {
    expect(htmlText('<h1><span>VideoQ</span> &amp; 講義</h1>')).toBe('VideoQ & 講義');
  });
  it('counts only root content and excludes script, style and template bodies', () => {
    expect(rootText('<title>Not body</title><div id="root"><p>Visible</p><script>hidden</script><style>hidden</style><template>hidden</template></div><p>Outside</p>')).toBe('Visible');
    expect(rootText('<p>No root</p>')).toBe('');
    expect(rootText('<div id="root"><script>unterminated script')).toBe('');
  });
});
