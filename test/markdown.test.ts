import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { renderMarkdown } from '../web/markdown.js';

type Node = string | { tag: string; props: Record<string, string>; children: Node[] };

const h = (tag: string, props: Record<string, string>, children: Node[]): Node => ({ tag, props, children });

function render(text: string): Node[] {
  return renderMarkdown(text, {
    h,
    mention: (name: string) => ({ tag: 'mention', props: {}, children: [name] }),
    ticket: (key: string, n: number) => (key === 'API' || key === 'ORC2' ? { tag: 'ticket', props: {}, children: [`${key}-${n}`] } : null),
  });
}

function html(nodes: Node[]): string {
  return nodes
    .map((n) =>
      typeof n === 'string'
        ? n
        : `<${n.tag}${Object.entries(n.props)
            .map(([k, v]) => ` ${k}="${v}"`)
            .join('')}>${html(n.children)}</${n.tag}>`,
    )
    .join('');
}

describe('markdown', () => {
  it('renders emphasis, code and links inline', () => {
    assert.equal(
      html(render('**Done.** See `quotes.ts` and *notes* at https://example.com/x.')),
      '<p><strong>Done.</strong> See <code class="md-code">quotes.ts</code> and <em>notes</em> at <a href="https://example.com/x" target="_blank" rel="noopener noreferrer">https://example.com/x</a>.</p>',
    );
  });

  it('renders fenced code without touching its contents', () => {
    assert.equal(html(render('```ts\nconst a = **b** + `c`;\n```')), '<pre><code>const a = **b** + `c`;</code></pre>');
  });

  it('renders lists, headings, quotes and rules', () => {
    assert.equal(html(render('## Plan\n- one\n- **two**\n\n3. three\n4. four')), '<p class="md-h md-h2">Plan</p><ul><li>one</li><li><strong>two</strong></li></ul><ol start="3"><li>three</li><li>four</li></ol>');
    assert.equal(html(render('> quoted *line*\n---')), '<blockquote><p>quoted <em>line</em></p></blockquote><hr></hr>');
  });

  it('keeps line breaks inside a paragraph', () => {
    assert.equal(html(render('line one\nline two\n\nnext')), '<p>line one<br></br>line two</p><p>next</p>');
  });

  it('treats HTML as plain text', () => {
    const nodes = render('<img src=x onerror=alert(1)> <script>alert(1)</script>');
    assert.deepEqual(nodes, [{ tag: 'p', props: {}, children: ['<img src=x onerror=alert(1)> <script>alert(1)</script>'] }]);
  });

  it('only links http and https', () => {
    assert.equal(html(render('[x](javascript:alert(1)) [y](https://ok.example)')), '<p>[x](javascript:alert(1)) <a href="https://ok.example" target="_blank" rel="noopener noreferrer">y</a></p>');
  });

  it('marks mentions but not emails or snake_case', () => {
    assert.equal(html(render('ask @ana-claude, mail ana@x.dev, call get_task_id')), '<p>ask <mention>ana-claude</mention>, mail ana@x.dev, call get_task_id</p>');
  });

  it('links ticket keys the app knows, and nothing that only looks like one', () => {
    assert.equal(
      html(render('Fixed API-12 and ORC2-3 (see **API-7**); UTF-8 and api-12 stay text')),
      '<p>Fixed <ticket>API-12</ticket> and <ticket>ORC2-3</ticket> (see <strong><ticket>API-7</ticket></strong>); UTF-8 and api-12 stay text</p>',
    );
    assert.equal(
      html(render('`API-12` https://x.dev/API-12 /tmp/API-12 API-12-b x.API-12')),
      '<p><code class="md-code">API-12</code> <a href="https://x.dev/API-12" target="_blank" rel="noopener noreferrer">https://x.dev/API-12</a> /tmp/API-12 API-12-b x.API-12</p>',
    );
  });
});
