/**
 * Markdown → Telegram HTML (gateway §5). Verifies each construct maps to the
 * right Telegram tag, that escaping is correct, and that code spans are not
 * re-formatted — i.e. the output is well-formed HTML Telegram will accept.
 */
import { describe, it, expect } from 'vitest';
import { mdToTelegramHtml, escapeHtml, htmlToPlain } from '../src/render/telegram-html.js';

const md = mdToTelegramHtml;

describe('escapeHtml', () => {
  it('escapes the three significant chars only', () => {
    expect(escapeHtml('a < b & c > d')).toBe('a &lt; b &amp; c &gt; d');
  });
});

describe('inline formatting', () => {
  it('bold / italic / strikethrough', () => {
    expect(md('**bold**')).toBe('<b>bold</b>');
    expect(md('__bold__')).toBe('<b>bold</b>');
    expect(md('a *italic* b')).toBe('a <i>italic</i> b');
    expect(md('~~gone~~')).toBe('<s>gone</s>');
  });
  it('inline code is escaped and not re-formatted', () => {
    expect(md('`a*b*c`')).toBe('<code>a*b*c</code>');
    expect(md('`x < y & z`')).toBe('<code>x &lt; y &amp; z</code>');
  });
  it('links become <a>', () => {
    expect(md('[site](https://x.test/a)')).toBe('<a href="https://x.test/a">site</a>');
  });
});

describe('blocks', () => {
  it('fenced code block with language', () => {
    expect(md('```js\nconst a = 1 < 2;\n```')).toBe(
      '<pre><code class="language-js">const a = 1 &lt; 2;</code></pre>',
    );
  });
  it('headings become bold; bullets normalized', () => {
    expect(md('# Title')).toBe('<b>Title</b>');
    expect(md('- one\n- two')).toBe('• one\n• two');
  });
  it('collapses a run of quote lines into one blockquote (with inline formatting)', () => {
    expect(md('> line **a**\n> line b')).toBe('<blockquote>line <b>a</b>\nline b</blockquote>');
  });
});

describe('GFM tables', () => {
  it('renders a table as an aligned <pre> grid', () => {
    const out = md('| A | B |\n| --- | --- |\n| 1 | 22 |\n| 333 | 4 |');
    expect(out.startsWith('<pre>')).toBe(true);
    expect(out.endsWith('</pre>')).toBe(true);
    expect(out).toContain('│'); // column separator
    expect(out).toContain('─'); // header rule
    expect(out).toContain('333');
  });
  it('flattens cell Markdown to plain text inside <pre>', () => {
    const out = md('| 名 | 值 |\n| --- | --- |\n| **粗** | `代码` |\n| [链](http://x) | a<br>b |');
    expect(out).toContain('粗');
    expect(out).not.toContain('**');
    expect(out).not.toContain('`代码`');
    expect(out).toContain('链'); // link text kept
    expect(out).not.toContain('http://x'); // url dropped
    expect(out).toContain('a / b'); // <br> → " / "
  });
  it('escapes table cell content', () => {
    expect(md('| x |\n| --- |\n| <b> |')).toContain('&lt;b&gt;');
  });
  it('leaves a lone pipe line untouched (not a table)', () => {
    expect(md('a | b')).toBe('a | b');
  });
});

describe('escaping safety', () => {
  it('plain angle brackets and ampersands are escaped (no raw < > besides tags)', () => {
    const out = md('use <html> & "quotes" here');
    expect(out).toBe('use &lt;html&gt; &amp; "quotes" here');
  });
  it('round-trips back to readable plain text', () => {
    expect(htmlToPlain('<b>hi</b> <code>x &lt; y</code>')).toBe('hi x < y');
  });
});
