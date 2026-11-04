import { OrcoError } from './errors.js';

/*
 * Webhook field filters (#132): rules on a delivery's headers and body, all of which must hold.
 * A path is `header.<name>` or `body.<dotted.path>`, where `[]` steps into every element of an array
 * (`body.pull_request.labels[].name`): the rule holds when any element satisfies it (for not_equals,
 * when none equals). No regular expressions: a pattern from a project admin must not be able to hang
 * the server.
 */
export const OPS = ['equals', 'not_equals', 'one_of', 'starts_with', 'exists'] as const;
export type Op = (typeof OPS)[number];
export interface Rule {
  path: string;
  op: Op;
  value?: string | string[];
}

const MAX_RULES = 10;
const PATH = /^(header\.[a-z0-9-]{1,80}|body(\.[A-Za-z0-9_-]{1,80}(\[\])?){1,12})$/;

export function checkRules(input: unknown): Rule[] {
  if (input === undefined || input === null) return [];
  if (!Array.isArray(input)) throw new OrcoError('invalid', 'Filters are a list of { path, op, value }');
  if (input.length > MAX_RULES) throw new OrcoError('invalid', `At most ${MAX_RULES} filters per hook`);
  return input.map((raw, i) => {
    const r = (raw ?? {}) as Record<string, unknown>;
    const path = String(r.path ?? '').trim().replace(/^header\.(.*)$/i, (_m, h: string) => `header.${h.toLowerCase()}`);
    if (!PATH.test(path)) throw new OrcoError('invalid', `Filter ${i + 1}: the path is header.<name> or body.<field.field>, with [] for arrays, like body.workflow_run.conclusion`);
    const op = String(r.op ?? '') as Op;
    if (!OPS.includes(op)) throw new OrcoError('invalid', `Filter ${i + 1}: the test is one of ${OPS.join(', ')}`);
    if (op === 'exists') return { path, op };
    const values = (Array.isArray(r.value) ? r.value : String(r.value ?? '').split(op === 'one_of' ? ',' : /\n/)).map((v) => String(v).trim()).filter(Boolean);
    if (!values.length) throw new OrcoError('invalid', `Filter ${i + 1}: give a value to compare with`);
    if (values.some((v) => v.length > 200)) throw new OrcoError('invalid', `Filter ${i + 1}: values are at most 200 characters`);
    return { path, op, value: op === 'one_of' ? values.slice(0, 20) : values[0]! };
  });
}

/** Parses "body.x.y equals failure" style lines, as typed in the app. */
export function parseRuleLine(line: string): Rule {
  const m = /^\s*(\S+)\s+(equals|not_equals|is_not|one_of|is_one_of|starts_with|exists)\b\s*(.*)$/i.exec(line);
  if (!m) throw new OrcoError('invalid', `Cannot read "${line.trim()}": write it as <path> <equals|not_equals|one_of|starts_with|exists> <value>`);
  const op = ({ is_not: 'not_equals', is_one_of: 'one_of' } as Record<string, string>)[m[2]!.toLowerCase()] ?? m[2]!.toLowerCase();
  return checkRules([{ path: m[1], op, value: m[3] }])[0]!;
}

/** Every value at a path ([] fans out over arrays). Scalars only; objects count as present. */
export function valuesAt(path: string, headers: Record<string, string | undefined>, body: unknown): unknown[] {
  if (path.startsWith('header.')) {
    const v = headers[path.slice(7)];
    return v === undefined ? [] : [v];
  }
  let current: unknown[] = [body];
  for (const part of path.split('.').slice(1)) {
    const fan = part.endsWith('[]');
    const key = fan ? part.slice(0, -2) : part;
    const next: unknown[] = [];
    for (const c of current) {
      if (!c || typeof c !== 'object') continue;
      const v = (c as Record<string, unknown>)[key];
      if (v === undefined) continue;
      if (fan) {
        if (Array.isArray(v)) next.push(...v);
      } else next.push(v);
    }
    current = next;
  }
  return current;
}

const text = (v: unknown) => (typeof v === 'string' ? v : typeof v === 'number' || typeof v === 'boolean' ? String(v) : v === null ? 'null' : '');

/** The first rule that does not hold, or null when all do. */
export function failingRule(rules: Rule[], headers: Record<string, string | undefined>, body: unknown): Rule | null {
  for (const rule of rules) {
    const found = valuesAt(rule.path, headers, body);
    const strs = found.map(text);
    const value = rule.value;
    const holds =
      rule.op === 'exists'
        ? found.length > 0
        : rule.op === 'equals'
          ? strs.includes(value as string)
          : rule.op === 'not_equals'
            ? !strs.includes(value as string)
            : rule.op === 'one_of'
              ? strs.some((s) => (value as string[]).includes(s))
              : strs.some((s) => s.startsWith(value as string));
    if (!holds) return rule;
  }
  return null;
}

export function describeRule(rule: Rule): string {
  if (rule.op === 'exists') return `${rule.path} exists`;
  return `${rule.path} ${rule.op.replace('_', ' ')} ${Array.isArray(rule.value) ? rule.value.join(', ') : rule.value}`;
}

/** The forge's delivery id header, the default duplicate key. */
export function deliveryId(headers: Record<string, string | undefined>, header: string | null): string | null {
  if (header) return headers[header.toLowerCase()] ?? null;
  return headers['x-github-delivery'] ?? headers['x-gitea-delivery'] ?? headers['x-forgejo-delivery'] ?? null;
}

/**
 * The coalesce value: deliveries with the same value inside the window share one task. With no key
 * set, a CI run's commit (workflow_run, check_suite or check_run head_sha, or a status's sha).
 */
export function coalesceValue(key: string | null, headers: Record<string, string | undefined>, body: unknown): string | null {
  if (key === 'off') return null;
  if (key) {
    const v = valuesAt(key, headers, body).map(text).filter(Boolean);
    return v.length ? v.join(',').slice(0, 200) : null;
  }
  const b = (body ?? {}) as Record<string, Record<string, unknown> | undefined>;
  const sha = b.workflow_run?.head_sha ?? b.check_suite?.head_sha ?? b.check_run?.head_sha ?? (b as Record<string, unknown>).sha;
  return typeof sha === 'string' && sha ? sha : null;
}
