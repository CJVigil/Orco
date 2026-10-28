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
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /(\b(?:authorization|bearer|token|api[_-]?key|password|secret)\b["']?\s*[:=]\s*["']?(?:bearer\s+)?)[^\s"',;]{12,}/gi,
];

export function maskSecrets(text: string, values: (string | undefined)[] = []): string {
  let out = text;
  for (const value of values) {
    if (value && value.length >= 8) out = out.split(value).join('[hidden]');
  }
  for (const pattern of PATTERNS) {
    out = out.replace(pattern, (match, prefix?: string) => (typeof prefix === 'string' && match.startsWith(prefix) ? `${prefix}[hidden]` : '[hidden]'));
  }
  return out;
}
