// Quotes (#123): an excerpt of a message or ticket comment, kept in the reply's own text so it
// survives edits, copies and the source going away:
//   > the excerpt, one or more lines
//   > — quoting message 123            (or: quoting comment 45 on SHO-3, or: quoting SHO-3)
// Pure functions, shared by the app and tested in test/quotes.test.ts.

const SOURCE = /^>\s*—\s*quoting (?:message (\d+)|comment (\d+) on ([A-Za-z][A-Za-z0-9]{0,9}-\d+)|([A-Za-z][A-Za-z0-9]{0,9}-\d+))\s*$/;

/** The quote block for an excerpt from a source. */
export function quoteText(excerpt, source) {
  const lines = excerpt.trim().replace(/\r/g, '').split('\n').slice(0, 12).map((l) => `> ${l}`.trimEnd());
  const where = source.kind === 'message' ? `message ${source.id}` : source.activityId ? `comment ${source.activityId} on ${source.ref}` : source.ref;
  return `${lines.join('\n')}\n> — quoting ${where}\n\n`;
}

/** The quotes in a text: each excerpt and where it came from. */
export function parseQuotes(text) {
  const out = [];
  const lines = String(text ?? '').split('\n');
  let block = [];
  for (const line of lines) {
    if (!line.startsWith('>')) {
      block = [];
      continue;
    }
    const m = SOURCE.exec(line);
    if (!m) {
      block.push(line.replace(/^>\s?/, ''));
      continue;
    }
    const source = m[1] ? { kind: 'message', id: Number(m[1]) } : m[2] ? { kind: 'comment', activityId: Number(m[2]), ref: m[3].toUpperCase() } : { kind: 'ticket', ref: m[4].toUpperCase() };
    if (block.length) out.push({ source, excerpt: block.join('\n').trim() });
    block = [];
  }
  return out;
}

/** The source line's parts, for the renderer to make it a link. */
export function quoteSource(line) {
  const m = SOURCE.exec(`> ${line.replace(/^>\s*/, '')}`);
  if (!m) return null;
  return m[1] ? { kind: 'message', id: Number(m[1]) } : m[2] ? { kind: 'comment', activityId: Number(m[2]), ref: m[3].toUpperCase() } : { kind: 'ticket', ref: m[4].toUpperCase() };
}
