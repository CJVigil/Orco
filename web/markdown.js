// A small, safe Markdown renderer. It never produces HTML strings: it calls `h(tag, props, children)`
// to build elements, and every piece of message text ends up as a text node.

const INLINE = [
  { type: 'code', re: /`([^`\n]+)`/ },
  { type: 'link', re: /\[([^\]\n]{1,200})\]\((https?:\/\/[^\s)]+)\)/ },
  { type: 'url', re: /https?:\/\/[^\s<>"]+[^\s<>".,;:!?)\]]/ },
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
    }
    consumed += m.index + m[0].length;
    rest = rest.slice(m.index + m[0].length);
  }
  return out;
}

const FENCE = /^\s*```\s*([\w+#.-]*)\s*$/;
const BULLET = /^\s*[-*+]\s+(.*)$/;
const NUMBERED = /^\s*(\d{1,9})[.)]\s+(.*)$/;
const HEADING = /^(#{1,3})\s+(.*)$/;
const QUOTE = /^\s*>\s?(.*)$/;
const RULE = /^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/;

export function renderMarkdown(text, opts) {
  const { h } = opts;
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const blocks = [];
  let i = 0;
  const isBlockStart = (line) =>
    FENCE.test(line) || BULLET.test(line) || NUMBERED.test(line) || HEADING.test(line) || QUOTE.test(line) || RULE.test(line);

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
      blocks.push(opts.codeBlock ? opts.codeBlock(code.join('\n'), fence[1]) : h('pre', {}, [h('code', {}, [code.join('\n')])]));
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
      blocks.push(h('blockquote', {}, renderMarkdown(quoted.join('\n'), opts)));
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
