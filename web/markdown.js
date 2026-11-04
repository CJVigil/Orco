// A small, safe Markdown renderer. It never produces HTML strings: it calls `h(tag, props, children)`
// to build elements, and every piece of message text ends up as a text node.

import { quoteSource } from './quotes.js';
const INLINE = [
  { type: 'code', re: /`([^`\n]+)`/ },
  { type: 'link', re: /\[([^\]\n]{1,200})\]\((https?:\/\/[^\s)]+)\)/ },
  { type: 'url', re: /https?:\/\/[^\s<>"]+[^\s<>".,;:!?)\]]/ },
  // A file path with an extension, and a line number when it has no folder: src/app.js:123, README.md:4.
  { type: 'path', re: /(?<![\w/.:@-])((?:[\w.-]+\/)+[\w.-]+\.[A-Za-z0-9]{1,8}(?::\d{1,7}(?::\d{1,5})?)?|[\w-][\w.-]*\.[A-Za-z0-9]{1,8}:\d{1,7}(?::\d{1,5})?)(?![\w/])/ },
  { type: 'bold', re: /\*\*([^*\n]+?)\*\*|__([^_\n]+?)__/ },
  { type: 'strike', re: /~~([^~\n]+?)~~/ },
  { type: 'italic', re: /(?<![\w*])\*([^*\s][^*\n]*?)\*(?![\w*])|(?<![\w_])_([^_\s][^_\n]*?)_(?![\w_])/ },
  { type: 'mention', re: /(?<![\w@])@([a-z0-9][a-z0-9-]{0,31})\b/ },
  { type: 'ticket', re: /(?<![\w/@.-])([A-Z][A-Z0-9]{0,9})-(\d{1,9})(?![\w-])/ },
];

for (const rule of INLINE) rule.at = new RegExp(rule.re.source, `${rule.re.flags}y`);

export function renderInline(text, opts) {
  const { h } = opts;
  const out = [];
  let rest = text;
  // Each rule's next match in `rest`, kept between tokens: re-scanning the whole remaining text for
  // every rule at every token was quadratic on long messages. A kept match stays the leftmost one,
  // except that a match may now start right at the beginning (the lookbehinds no longer see the
  // text before it), which the sticky `at` check catches.
  const next = new Map();
  let consumed = 0;
  while (rest) {
    let best = null;
    for (const rule of INLINE) {
      let m = next.get(rule);
      if (m === undefined || (m !== null && m.from < consumed)) {
        m = rule.re.exec(rest);
        if (m) m.from = consumed + m.index;
      } else {
        rule.at.lastIndex = 0;
        const here = rule.at.exec(rest);
        if (here) {
          here.from = consumed;
          m = here;
        } else if (m) {
          m.index = m.from - consumed;
        }
      }
      next.set(rule, m);
      if (m && (best === null || m.index < best.m.index)) best = { rule, m };
    }
    if (!best) {
      out.push(rest);
      break;
    }
    const { rule, m } = best;
    if (m.index > 0) out.push(rest.slice(0, m.index));
    const inner = m[1] ?? m[2] ?? '';
    switch (rule.type) {
      case 'code':
        out.push(h('code', { class: 'md-code' }, [inner]));
        break;
      case 'link':
        out.push(h('a', { href: m[2], target: '_blank', rel: 'noopener noreferrer' }, renderInline(m[1], opts)));
        break;
      case 'url':
        out.push(h('a', { href: m[0], target: '_blank', rel: 'noopener noreferrer' }, [m[0]]));
        break;
      case 'bold':
        out.push(h('strong', {}, renderInline(inner, opts)));
        break;
      case 'strike':
        out.push(h('s', {}, renderInline(inner, opts)));
        break;
      case 'italic':
        out.push(h('em', {}, renderInline(inner, opts)));
        break;
      case 'mention':
        out.push(opts.mention ? opts.mention(m[1]) : `@${m[1]}`);
        break;
      case 'ticket':
        out.push(opts.ticket?.(m[1], Number(m[2])) ?? m[0]);
        break;
      case 'path':
        out.push(opts.path ? opts.path(m[1]) : h('span', { class: 'md-path' }, [m[1]]));
        break;
    }
    consumed += m.index + m[0].length;
    rest = rest.slice(m.index + m[0].length);
  }
  return out;
}

const FENCE = /^\s*```\s*([\w+#.-]*)\s*$/;
// Claude Code style work rows: "● Ran tests" with its result on a "⎿" line (#92).
const WORK = /^\s*[●⏺]\s+(.*)$/;
const RESULT = /^\s*⎿\s?(.*)$/;
const DETAIL = /^\s{2,}\S/;
const BULLET = /^\s*[-*+]\s+(.*)$/;
const NUMBERED = /^\s*(\d{1,9})[.)]\s+(.*)$/;
const HEADING = /^(#{1,3})\s+(.*)$/;
const QUOTE = /^\s*>\s?(.*)$/;
const RULE = /^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/;

/** The children of a code block's <code>: a diff gets one span per line, colored by what it does. */
export function codeChildren(code, lang, h) {
  if (!/^(diff|patch)$/i.test(lang ?? '')) return [code];
  const lines = code.split('\n');
  return lines.map((line) => {
    const kind = /^(\+\+\+|---)( |$)/.test(line) ? 'meta' : line.startsWith('+') ? 'add' : line.startsWith('-') ? 'del' : line.startsWith('@@') ? 'hunk' : null;
    // One block per line (no newline inside), so each line can carry its color edge to edge.
    return h('span', { class: kind ? `md-diff-line md-diff-${kind}` : 'md-diff-line' }, [line || ' ']);
  });
}

/**
 * One work row: the action, its first result on a "⎿" line, and any further lines folded under it.
 * Collapsed by default, like a finished step in Claude Code.
 */
function workItem(item, opts) {
  const { h } = opts;
  const head = [h('span', { class: 'md-work-head' }, [h('span', { class: 'md-work-dot', 'aria-hidden': 'true' }, ['●']), h('span', { class: 'md-work-action' }, renderInline(item.action, opts))])];
  if (item.results.length) head.push(h('span', { class: 'md-work-result' }, ['⎿ ', ...renderInline(item.results[0], opts)]));
  if (item.results.length <= 1) return h('div', { class: 'md-work-item' }, head);
  return h('details', { class: 'md-work-item' }, [
    h('summary', {}, head),
    h('div', { class: 'md-work-more' }, item.results.slice(1).flatMap((line, n) => (n ? [h('br', {}, []), ...renderInline(line, opts)] : renderInline(line, opts)))),
  ]);
}

/** Work rows from lines: an action starts each row, "⎿" and indented lines are its results. */
function workItems(lines, fenced) {
  const items = [];
  for (const raw of lines) {
    if (!raw.trim()) continue;
    const work = WORK.exec(raw);
    const result = RESULT.exec(raw);
    if (work || (fenced && !result && !DETAIL.test(raw))) {
      const text = work ? work[1] : raw.trim();
      const split = text.indexOf('⎿');
      items.push({ action: (split >= 0 ? text.slice(0, split) : text).trim(), results: split >= 0 ? [text.slice(split + 1).trim()] : [] });
    } else if (items.length) {
      items.at(-1).results.push(result ? result[1].trim() : raw.trim());
    }
  }
  return items;
}

export function renderMarkdown(text, opts) {
  const { h } = opts;
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const blocks = [];
  let i = 0;
  const isBlockStart = (line) =>
    FENCE.test(line) || BULLET.test(line) || NUMBERED.test(line) || HEADING.test(line) || QUOTE.test(line) || RULE.test(line) || WORK.test(line);
  // The first line of a longer message reads as its headline (#92), unless it starts a block itself.
  if (opts.headline) {
    const first = lines.findIndex((l) => l.trim());
    const more = first >= 0 && lines.slice(first + 1).some((l) => l.trim());
    if (more && !isBlockStart(lines[first])) {
      blocks.push(h('p', { class: 'md-headline' }, renderInline(lines[first].trim(), opts)));
      i = first + 1;
    }
  }

  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      i++;
      continue;
    }
    const fence = FENCE.exec(line);
    if (fence) {
      const code = [];
      i++;
      while (i < lines.length && !FENCE.test(lines[i])) code.push(lines[i++]);
      i++;
      if (fence[1].toLowerCase() === 'work') {
        blocks.push(h('div', { class: 'md-work' }, workItems(code, true).map((item) => workItem(item, opts))));
        continue;
      }
      blocks.push(opts.codeBlock ? opts.codeBlock(code.join('\n'), fence[1]) : h('pre', {}, [h('code', {}, codeChildren(code.join('\n'), fence[1], h))]));
      continue;
    }
    if (WORK.test(line)) {
      const group = [line];
      i++;
      while (i < lines.length && lines[i].trim() && (WORK.test(lines[i]) || RESULT.test(lines[i]) || DETAIL.test(lines[i]))) group.push(lines[i++]);
      blocks.push(h('div', { class: 'md-work' }, workItems(group, false).map((item) => workItem(item, opts))));
      continue;
    }
    if (RULE.test(line)) {
      blocks.push(h('hr', {}, []));
      i++;
      continue;
    }
    const heading = HEADING.exec(line);
    if (heading) {
      blocks.push(h('p', { class: `md-h md-h${heading[1].length}` }, renderInline(heading[2], opts)));
      i++;
      continue;
    }
    if (QUOTE.test(line)) {
      const quoted = [];
      while (i < lines.length && QUOTE.test(lines[i])) quoted.push(QUOTE.exec(lines[i++])[1]);
      // A quote of a message or comment (#123): its last line names the source, shown as a link back.
      const source = quoted.length > 1 ? quoteSource(quoted[quoted.length - 1]) : null;
      if (source && opts.quote) {
        const excerpt = quoted.slice(0, -1).join('\n');
        blocks.push(h('blockquote', { class: 'quote' }, [...renderMarkdown(excerpt, { ...opts, headline: false }), opts.quote(source, excerpt)]));
        continue;
      }
      blocks.push(h('blockquote', {}, renderMarkdown(quoted.join('\n'), { ...opts, headline: false })));
      continue;
    }
    if (BULLET.test(line) || NUMBERED.test(line)) {
      const ordered = NUMBERED.test(line);
      const pattern = ordered ? NUMBERED : BULLET;
      const items = [];
      const start = ordered ? Number(NUMBERED.exec(line)[1]) : 1;
      while (i < lines.length && pattern.test(lines[i])) {
        const m = pattern.exec(lines[i++]);
        items.push(h('li', {}, renderInline(ordered ? m[2] : m[1], opts)));
      }
      blocks.push(h(ordered ? 'ol' : 'ul', ordered && start !== 1 ? { start: String(start) } : {}, items));
      continue;
    }
    const para = [];
    while (i < lines.length && lines[i].trim() && (para.length === 0 || !isBlockStart(lines[i]))) para.push(lines[i++]);
    const children = [];
    para.forEach((l, n) => {
      if (n > 0) children.push(h('br', {}, []));
      children.push(...renderInline(l, opts));
    });
    blocks.push(h('p', {}, children));
  }
  return blocks;
}
