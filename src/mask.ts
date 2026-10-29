/**
 * Hides secrets in text that leaves a machine, such as agent run logs: given values (tokens the
 * bridge handed out, keys from its config) and well-known credential shapes.
 */
const PATTERNS: RegExp[] = [
  /\borco_[a-z]_[A-Za-z0-9_-]{16,}/g,
  /\b(?:sk|rk)-(?:ant-|proj-)?[A-Za-z0-9_-]{20,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{30,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{30,}/g,
  /\bglpat-[A-Za-z0-9_-]{20,}/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bAIza[0-9A-Za-z_-]{35}\b/g,
  /(\b(?:authorization|bearer|token|api[_-]?key|password|secret)\b["']?\s*[:=]\s*["']?(?:bearer\s+)?)[^\s"',;]{12,}/gi,
];

const KEY_BEGIN = /-----BEGIN [A-Z ]{0,40}PRIVATE KEY-----/g;
const KEY_END = /^-----END [A-Z ]{0,40}PRIVATE KEY-----/;

/**
 * Hides PEM private keys. A scan, not one regex: a lazy match from each BEGIN to the next END is
 * quadratic on text with many BEGINs and no END, which let one run log stall the server (#33).
 */
function maskPrivateKeys(text: string): string {
  let out = '';
  let from = 0;
  KEY_BEGIN.lastIndex = 0;
  for (let begin = KEY_BEGIN.exec(text); begin; begin = KEY_BEGIN.exec(text)) {
    let end = -1;
    for (let at = text.indexOf('-----END ', KEY_BEGIN.lastIndex); at !== -1; at = text.indexOf('-----END ', at + 1)) {
      const closing = KEY_END.exec(text.slice(at, at + 64));
      if (closing) {
        end = at + closing[0].length;
        break;
      }
    }
    if (end === -1) break; // no END after this BEGIN, so none after any later one either
    out += `${text.slice(from, begin.index)}[hidden]`;
    from = end;
    KEY_BEGIN.lastIndex = end;
  }
  return out + text.slice(from);
}

export function maskSecrets(text: string, values: (string | undefined)[] = []): string {
  let out = maskPrivateKeys(text);
  for (const value of values) {
    if (value && value.length >= 8) out = out.split(value).join('[hidden]');
  }
  for (const pattern of PATTERNS) {
    out = out.replace(pattern, (match, prefix?: string) => (typeof prefix === 'string' && match.startsWith(prefix) ? `${prefix}[hidden]` : '[hidden]'));
  }
  return out;
}
