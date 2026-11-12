import { OrcoError } from '../errors.js';

/*
 * Where Orco keeps its data (#148): a SQLite file (the default), a PostgreSQL database or a MongoDB
 * database. Set with --db or ORCO_DB (a file path or a URL), or ORCO_DB=sqlite|postgres|mongo with
 * ORCO_DATABASE_URL.
 */
export type Target =
  | { kind: 'sqlite'; path: string }
  | { kind: 'postgres'; url: string; schema?: string }
  | { kind: 'mongo'; url: string; database?: string };

export const KINDS = ['sqlite', 'postgres', 'mongo'] as const;

export function parseTarget(value: string): Target {
  const v = value.trim();
  if (!v) throw new OrcoError('invalid', 'Say where the database is: a file path, postgres://… or mongodb://…');
  if (/^postgres(ql)?:\/\//i.test(v)) return { kind: 'postgres', url: v };
  if (/^mongodb(\+srv)?:\/\//i.test(v)) return { kind: 'mongo', url: v };
  if (/^sqlite:/i.test(v)) return { kind: 'sqlite', path: v.replace(/^sqlite:(\/\/)?/i, '') || './orco.db' };
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(v)) throw new OrcoError('invalid', `Orco stores data in SQLite, PostgreSQL or MongoDB; ${v.split(':')[0]}:// is none of them`);
  return { kind: 'sqlite', path: v };
}

/** The database from the command line and environment. */
export function targetFromEnv(dbOption: string | undefined, env: NodeJS.ProcessEnv = process.env): Target {
  const kind = env.ORCO_DB?.trim().toLowerCase();
  const url = env.ORCO_DATABASE_URL?.trim();
  if (dbOption && dbOption !== env.ORCO_DB) return parseTarget(dbOption);
  if (kind === 'postgres' || kind === 'postgresql' || kind === 'mongo' || kind === 'mongodb') {
    if (!url) throw new OrcoError('invalid', `ORCO_DB=${kind} needs ORCO_DATABASE_URL, like ${kind.startsWith('p') ? 'postgres://orco:secret@db:5432/orco' : 'mongodb://db:27017/orco?replicaSet=rs0'}`);
    const t = parseTarget(url);
    if (t.kind !== (kind.startsWith('p') ? 'postgres' : 'mongo')) throw new OrcoError('invalid', `ORCO_DB=${kind} but ORCO_DATABASE_URL is a ${t.kind} address`);
    return t;
  }
  if (kind === 'sqlite') return parseTarget(url || './orco.db');
  if (url) return parseTarget(url);
  return parseTarget(dbOption || env.ORCO_DB || './orco.db');
}

/** The address with any password hidden, for logs and messages. */
export function describeTarget(t: Target): string {
  if (t.kind === 'sqlite') return t.path;
  try {
    const u = new URL(t.url);
    if (u.password) u.password = '***';
    return u.toString();
  } catch {
    return `${t.kind} database`;
  }
}
