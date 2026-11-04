import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { quotesIn } from '../src/quotes.js';
import { renderMarkdown } from '../web/markdown.js';
import { parseQuotes, quoteText } from '../web/quotes.js';

type Node = { tag: string; props: Record<string, unknown>; children: (Node | string)[] };
const h = (tag: string, props: Record<string, unknown>, children: (Node | string)[]) => ({ tag, props, children });

describe('quote a line (#123)', () => {
  it('writes a quote into the reply text and reads it back, with its source', () => {
    const block = quoteText('Step 3 retries the payment twice.', { kind: 'message', id: 42 });
    assert.equal(block, '> Step 3 retries the payment twice.\n> — quoting message 42\n\n');
    const reply = `${block}That should be once; a second charge can happen.`;
    assert.deepEqual(parseQuotes(reply), [{ source: { kind: 'message', id: 42 }, excerpt: 'Step 3 retries the payment twice.' }]);
    assert.deepEqual(quotesIn(reply), [{ source: 'message 42', excerpt: 'Step 3 retries the payment twice.' }], 'agents get it as structured context');
    const comment = quoteText('a\nb', { kind: 'comment', activityId: 7, ref: 'sho-3' });
    assert.deepEqual(parseQuotes(comment), [{ source: { kind: 'comment', activityId: 7, ref: 'SHO-3' }, excerpt: 'a\nb' }]);
    assert.deepEqual(parseQuotes('> just a blockquote\nno source'), []);
  });

  it('renders a quote with a link back to its source', () => {
    const seen: unknown[] = [];
    const nodes = renderMarkdown('> one line\n> — quoting comment 9 on SHO-2\n\nmy answer', {
      h,
      quote: (source: unknown, excerpt: string) => (seen.push([source, excerpt]), h('button', {}, ['link'])),
    }) as Node[];
    assert.equal(nodes[0]!.tag, 'blockquote');
    assert.equal(nodes[0]!.props.class, 'quote');
    assert.deepEqual(seen, [[{ kind: 'comment', activityId: 9, ref: 'SHO-2' }, 'one line']]);
  });
});
