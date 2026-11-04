/*
 * Quotes (#123) as agents see them: the excerpts a message or comment quotes, with their source, so an
 * agent acts on the line a person meant. The format lives in web/quotes.js; this reads it.
 */
const SOURCE = /^>\s*—\s*quoting (?:message (\d+)|comment (\d+) on ([A-Za-z][A-Za-z0-9]{0,9}-\d+)|([A-Za-z][A-Za-z0-9]{0,9}-\d+))\s*$/;

export interface Quote {
  source: string;
  excerpt: string;
}

export function quotesIn(text: string | null | undefined): Quote[] {
  const out: Quote[] = [];
  let block: string[] = [];
  for (const line of String(text ?? '').split('\n')) {
    if (!line.startsWith('>')) {
      block = [];
      continue;
    }
    const m = SOURCE.exec(line);
    if (!m) {
      block.push(line.replace(/^>\s?/, ''));
      continue;
    }
    const source = m[1] ? `message ${m[1]}` : m[2] ? `comment ${m[2]} on ${m[3]!.toUpperCase()}` : `ticket ${m[4]!.toUpperCase()}`;
    if (block.length) out.push({ source, excerpt: block.join('\n').trim() });
    block = [];
  }
  return out;
}
