import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { parseArgs } from 'node:util';
import { EventStream } from './bridge/events.js';

/** Commands that talk to a running Orco server over HTTP, from any machine with a token. */
export const CLIENT_COMMANDS = new Set([
  'login',
  'logout',
  'whoami',
  'inbox',
  'catch-up',
  'wait',
  'post',
  'read',
  'search',
  'tasks',
  'task',
  'answer',
  'tickets',
  'ticket',
  'api',
]);

export const CLIENT_USAGE = `Client commands (talk to a running server; set ORCO_URL and ORCO_TOKEN, or run orco login):
  login <url> [--token T]       Save the server and your token (token from --token, ORCO_TOKEN or stdin)
  logout                        Forget them
  whoami                        Who the token belongs to
  inbox                         What needs you: approvals, questions, reviews, tasks, mentions
  catch-up [room]               New messages, thread digests and changed tickets since you last looked
  wait [--timeout S]            Wait until someone mentions you; prints the message (exit 2 on timeout)
  post <room> <text|-> [--thread ID] [--file PATH]...   Post a message (- reads stdin)
  read <room> [--thread ID] [--limit N]
  search <words...> [--kind message,ticket,note,task]
  tasks [--requested] [--room R] [--all]
  task <id>
  task new @agent <room> <request...> [--minutes N] [--cost 2.50]
  task accept|done|fail|decline|cancel <id> [note...] [--link URL]...
  task progress <id> <text...> [--percent N]
  task checkpoint <id> <text...>
  task ask <id> <question...>   Ask the requester something you need; the task waits for the answer
  answer <question-id> <answer...>
  tickets [project] [--assignee NAME|me] [--status S] [--all]
  ticket <ref>
  ticket new <project> <title...> [--description D] [--assignee A] [--priority P] [--label L]...
  ticket move <ref> <status...>
  ticket comment <ref> <text...>
  ticket claim <ref>
  api <GET|POST|DELETE> <path> [json|-]   Any REST endpoint, like gh api
Add --json to most commands for machine-readable output.
`;

export interface ClientIO {
  env: NodeJS.ProcessEnv;
  out: (text: string) => void;
  err: (text: string) => void;
  stdin: () => Promise<string>;
}

class ClientError extends Error {
  constructor(
    message: string,
    readonly exitCode = 1,
  ) {
    super(message);
  }
}

interface Config {
  server: string;
  token: string;
}

function configPath(env: NodeJS.ProcessEnv): string {
  if (env.ORCO_CLIENT_CONFIG) return env.ORCO_CLIENT_CONFIG;
  const base = process.platform === 'win32' ? env.APPDATA || join(homedir(), 'AppData', 'Roaming') : env.XDG_CONFIG_HOME || join(homedir(), '.config');
  return join(base, 'orco', 'client.json');
}

function loadConfig(env: NodeJS.ProcessEnv): Config {
  let saved: Partial<Config> = {};
  const path = configPath(env);
  if (existsSync(path)) {
    try {
      saved = JSON.parse(readFileSync(path, 'utf8')) as Partial<Config>;
    } catch {
      throw new ClientError(`${path} is not valid JSON; run orco login again`);
    }
  }
  const server = (env.ORCO_URL || saved.server || '').replace(/\/+$/, '');
  const token = env.ORCO_TOKEN || saved.token || '';
  if (!server || !token) throw new ClientError('Not signed in: run orco login <url>, or set ORCO_URL and ORCO_TOKEN');
  return { server, token };
}

async function request(config: Config, method: string, path: string, body?: unknown, raw?: { data: Buffer; type: string }): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch(`${config.server}${path.startsWith('/') ? path : `/${path}`}`, {
      method,
      headers: {
        Authorization: `Bearer ${config.token}`,
        ...(raw ? { 'Content-Type': raw.type } : body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      body: raw ? new Uint8Array(raw.data) : body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch (err) {
    throw new ClientError(`Cannot reach ${config.server}: ${(err as Error).message}`);
  }
  if (res.status === 204) return null;
  const text = await res.text();
  let data: unknown = text;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    // Not JSON (an attachment, say); return the text.
  }
  if (!res.ok) {
    const message = (data as { error?: string } | null)?.error ?? `HTTP ${res.status}`;
    throw new ClientError(res.status === 401 ? `${message}: the token was refused` : message);
  }
  return data;
}

/* Formatting: short, greppable lines. */

type Json = Record<string, any>;

function when(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toISOString().slice(0, 16).replace('T', ' ');
}

function oneLine(text: string, max = 200): string {
  const flat = (text ?? '').replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function formatMessage(m: Json): string {
  const lines = [`[${m.id}] ${when(m.createdAt)} ${m.author}${m.owner ? ` (agent of ${m.owner})` : ''} in #${m.room}${m.threadId ? ` thread ${m.threadId}` : ''}`];
  if (m.text) lines.push(...String(m.text).split('\n').map((l: string) => `  ${l}`));
  if (m.external) lines.push(`  [external, untrusted, from ${m.external.source}]`, ...String(m.external.text).split('\n').map((l: string) => `  | ${l}`));
  for (const a of m.attachments ?? []) lines.push(`  [${a.mime === 'text/plain' ? 'file' : 'image'} ${a.id}: ${a.name}, ${a.size} bytes]`);
  if (m.task) lines.push(`  [task #${m.task.id} → ${m.task.assignee}: ${m.task.state}]`);
  if (m.question) lines.push(`  [question ${m.question.id} for ${m.question.target}: ${m.question.state}]`);
  if (m.approval) lines.push(`  [approval ${m.approval.id}: ${m.approval.state}]`);
  if (m.review) lines.push(`  [review ${m.review.id} of ${m.review.target}: ${m.review.state}]`);
  return lines.join('\n');
}

function formatTask(t: Json): string {
  const lines = [`#${t.id} ${t.state}${t.stalled ? ' (stalled)' : ''}  ${t.requester} → ${t.assignee}  in #${t.room}`, `  ${oneLine(t.request, 300)}`];
  if (t.progress) lines.push(`  progress: ${t.progress.text}${t.progress.percent !== null ? ` (${t.progress.percent}%)` : ''}`);
  if (t.question) lines.push(`  question ${t.question.id} (${t.question.state}): ${oneLine(t.question.question)}${t.question.answer ? ` → ${oneLine(t.question.answer)}` : ''}`);
  if (t.checkpoint) lines.push(`  checkpoint: ${oneLine(t.checkpoint.text, 300)}`);
  if (t.note) lines.push(`  note: ${oneLine(t.note, 300)}`);
  for (const link of t.links ?? []) lines.push(`  link: ${link.title ? `${link.title} ` : ''}${link.url}`);
  return lines.join('\n');
}

function formatTicket(t: Json): string {
  const tags = [t.priority !== 'none' ? t.priority : null, t.assignee ? `@${t.assignee.name}` : null, t.blocked ? 'blocked' : null, ...(t.labels ?? []).map((l: Json) => `#${l.name}`)]
    .filter(Boolean)
    .join(' ');
  return `${t.ref.padEnd(8)} ${String(t.status?.name ?? '').padEnd(12)} ${oneLine(t.title, 80)}${tags ? `  ${tags}` : ''}`;
}

function formatTicketDetail(t: Json): string {
  const lines = [formatTicket(t), `  project ${t.project} · created by ${t.creator} · updated ${when(t.updatedAt)}`];
  if (t.description) lines.push('', ...String(t.description).split('\n').map((l: string) => `  ${l}`));
  if (t.handoff?.text) lines.push('', `  handoff (${t.handoff.by}): ${t.handoff.text}`);
  for (const c of t.criteriaItems ?? []) lines.push(`  [${c.done ? 'x' : ' '}] ${c.id}: ${c.text}`);
  if (t.blockers?.length) lines.push(`  blocked by: ${t.blockers.map((b: Json) => `${b.ref} (${b.status})`).join(', ')}`);
  const comments = (t.activity ?? []).filter((a: Json) => a.kind === 'comment').slice(-5);
  if (comments.length) lines.push('', '  recent comments:', ...comments.map((a: Json) => `  - ${a.actor ?? 'Orco'} (${when(a.createdAt)}): ${oneLine(a.body, 300)}`));
  return lines.join('\n');
}

function formatInbox(i: Json): string {
  const out: string[] = [];
  const section = (title: string, items: string[]) => {
    if (items.length) out.push(`${title} (${items.length})`, ...items.map((s) => `  ${s}`), '');
  };
  section('Needs your decision', i.approvals.map((a: Json) => `approval ${a.id} from ${a.requester} in #${a.room}: ${oneLine(a.summary)}`));
  section('Questions for you', i.questions.map((q: Json) => `question ${q.id} from ${q.asker} on task #${q.taskId}: ${oneLine(q.question)}`));
  section('Reviews for you', (i.reviews ?? []).map((r: Json) => `review ${r.id} of ${r.target} for ${r.requester}: ${oneLine(r.summary)}`));
  section('Suggested follow-ups', (i.suggestions ?? []).map((s: Json) => `suggestion ${s.id} from task #${s.taskId}: ${oneLine(s.title)}`));
  section('Flagged by your agents', i.flags.map((f: Json) => `flag ${f.id} by ${f.flagger}: ${oneLine(f.reason)}`));
  section('Stalled', i.stalled.map((t: Json) => `task #${t.id} → ${t.assignee}: ${oneLine(t.request)}`));
  section('Open tasks', i.tasks.map((t: Json) => `task #${t.id} ${t.state} → ${t.assignee}: ${oneLine(t.request)}`));
  section('Tickets assigned to you', i.tickets.map(formatTicket));
  section('Unseen mentions', i.mentions.filter((m: Json) => !m.seen).map((m: Json) => `[${m.id}] ${m.author} in #${m.room}: ${oneLine(m.text)}`));
  return out.length ? out.join('\n').trimEnd() : 'Nothing needs you right now.';
}

/* Commands */

export async function runClient(argv: string[], io: ClientIO): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      json: { type: 'boolean' },
      token: { type: 'string' },
      thread: { type: 'string' },
      file: { type: 'string', multiple: true },
      limit: { type: 'string' },
      kind: { type: 'string' },
      requested: { type: 'boolean' },
      room: { type: 'string' },
      all: { type: 'boolean' },
      minutes: { type: 'string' },
      cost: { type: 'string' },
      link: { type: 'string', multiple: true },
      percent: { type: 'string' },
      assignee: { type: 'string' },
      status: { type: 'string' },
      description: { type: 'string' },
      priority: { type: 'string' },
      label: { type: 'string', multiple: true },
      timeout: { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  const [command, ...rest] = positionals;
  const print = (value: unknown, text: () => string) => io.out(values.json ? JSON.stringify(value, null, 2) : text());
  const int = (value: string | undefined, what: string): number | undefined => {
    if (value === undefined) return undefined;
    const n = Number(value);
    if (!Number.isInteger(n)) throw new ClientError(`${what} must be a whole number`);
    return n;
  };
  const need = (value: string | undefined, usage: string): string => {
    if (!value) throw new ClientError(`Usage: orco ${usage}`);
    return value;
  };
  const textArg = async (parts: string[], usage: string) => {
    if (parts.length === 1 && parts[0] === '-') return (await io.stdin()).replace(/\n$/, '');
    const text = parts.join(' ');
    if (!text) throw new ClientError(`Usage: orco ${usage}`);
    return text;
  };

  try {
    if (values.help) {
      io.out(CLIENT_USAGE);
      return 0;
    }
    if (command === 'login') {
      const server = need(rest[0], 'login <url> [--token T]').replace(/\/+$/, '');
      const token = values.token || io.env.ORCO_TOKEN || (await io.stdin()).trim();
      if (!token) throw new ClientError('Give the token with --token, ORCO_TOKEN, or on stdin');
      const me = (await request({ server, token }, 'GET', '/api/me')) as Json;
      const path = configPath(io.env);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, JSON.stringify({ server, token }, null, 2), { mode: 0o600 });
      try {
        chmodSync(path, 0o600);
      } catch {
        // Windows: the file sits in the user's own profile.
      }
      io.out(`Signed in to ${server} as ${me.kind} ${me.name}. Saved to ${path}.`);
      return 0;
    }
    if (command === 'logout') {
      rmSync(configPath(io.env), { force: true });
      io.out('Signed out.');
      return 0;
    }

    const config = loadConfig(io.env);
    const call = (method: string, path: string, body?: unknown) => request(config, method, path, body);
    const enc = encodeURIComponent;

    switch (command) {
      case 'whoami': {
        const me = (await call('GET', '/api/me')) as Json;
        print(me, () => `${me.name} (${me.kind}${me.owner ? `, owned by ${me.owner}` : ''}) on ${config.server}`);
        return 0;
      }
      case 'inbox': {
        const inbox = (await call('GET', '/api/inbox')) as Json;
        print(inbox, () => formatInbox(inbox));
        return 0;
      }
      case 'catch-up': {
        const result = (await call('GET', `/api/catch-up${rest[0] ? `?room=${enc(rest[0])}` : ''}`)) as Json;
        print(result, () => {
          const out: string[] = [];
          for (const room of result.rooms) {
            out.push(`#${room.room}${room.skipped ? ` (${room.skipped} older new messages skipped)` : ''}`);
            for (const m of room.messages) out.push(formatMessage(m));
            for (const t of room.threads) out.push(`  thread ${t.threadId}: ${t.newReplies} new repl${t.newReplies === 1 ? 'y' : 'ies'}${t.summary ? `; summary: ${oneLine(t.summary)}` : `; last from ${t.last.author}: ${oneLine(t.last.text)}`}`);
            out.push('');
          }
          if (result.tickets.length) out.push('Changed tickets', ...result.tickets.map((t: Json) => `  ${formatTicket(t)}`));
          return out.length ? out.join('\n').trimEnd() : 'Nothing new.';
        });
        return 0;
      }
      case 'wait': {
        const timeout = (int(values.timeout, '--timeout') ?? 0) * 1000;
        const me = (await call('GET', '/api/me')) as Json;
        const message = await new Promise<Json | null>((resolve) => {
          const stream = new EventStream({
            url: `${config.server}/api/events`,
            headers: { Authorization: `Bearer ${config.token}` },
            onEvent: ({ event, data }) => {
              const m = data as Json;
              if (event === 'message' && m.author !== me.name && (m.mentions ?? []).includes(me.name)) {
                stream.stop();
                if (timer) clearTimeout(timer);
                resolve(m);
              }
            },
          });
          const timer = timeout
            ? setTimeout(() => {
                stream.stop();
                resolve(null);
              }, timeout)
            : null;
          void stream.start();
        });
        if (!message) {
          io.err('No mention before the timeout.');
          return 2;
        }
        print(message, () => formatMessage(message));
        return 0;
      }
      case 'post': {
        const room = need(rest[0], 'post <room> <text|->');
        const text = values.file?.length && rest.length === 1 ? '' : await textArg(rest.slice(1), 'post <room> <text|->');
        const ids: number[] = [];
        for (const path of values.file ?? []) {
          let data: Buffer;
          try {
            data = readFileSync(path);
          } catch {
            throw new ClientError(`Cannot read ${path}`);
          }
          const upload = (await request(config, 'POST', `/api/attachments?room=${enc(room)}&name=${enc(basename(path))}`, undefined, {
            data,
            type: 'application/octet-stream',
          })) as Json;
          ids.push(upload.id);
        }
        const message = (await call('POST', '/api/messages', { room, text, thread_id: int(values.thread, '--thread'), attachment_ids: ids })) as Json;
        print(message, () => `Posted [${message.id}] in #${message.room}.`);
        return 0;
      }
      case 'read': {
        const room = need(rest[0], 'read <room>');
        const params = new URLSearchParams({ room });
        if (values.thread) params.set('thread_id', values.thread);
        params.set('limit', String(int(values.limit, '--limit') ?? 30));
        const messages = (await call('GET', `/api/messages?${params}`)) as Json[];
        print(messages, () => (messages.length ? messages.map(formatMessage).join('\n') : 'No messages.'));
        return 0;
      }
      case 'search': {
        const query = rest.join(' ');
        if (!query) throw new ClientError('Usage: orco search <words...>');
        const hits = (await call('GET', `/api/search?q=${enc(query)}${values.kind ? `&kind=${enc(values.kind)}` : ''}`)) as Json[];
        print(hits, () => (hits.length ? hits.map((h) => `${h.kind.padEnd(7)} ${h.title}  (${when(h.at)})\n  ${h.snippet}`).join('\n') : 'Nothing matches every word.'));
        return 0;
      }
      case 'tasks': {
        const me = (await call('GET', '/api/me')) as Json;
        const params = new URLSearchParams();
        if (!values.all) params.set('open', '1');
        if (values.room) params.set('room', values.room);
        else if (values.requested || me.kind === 'user') params.set('mine', '1');
        else params.set('assigned', '1');
        const tasks = (await call('GET', `/api/tasks?${params}`)) as Json[];
        print(tasks, () => (tasks.length ? tasks.map(formatTask).join('\n') : 'No tasks.'));
        return 0;
      }
      case 'task': {
        const [sub, ...args] = rest;
        if (sub && /^\d+$/.test(sub)) {
          const task = (await call('GET', `/api/tasks/${sub}`)) as Json;
          print(task, () => formatTask(task));
          return 0;
        }
        if (sub === 'new') {
          const agent = need(args[0], 'task new @agent <room> <request...>').replace(/^@/, '');
          const room = need(args[1], 'task new @agent <room> <request...>');
          const request = await textArg(args.slice(2), 'task new @agent <room> <request...>');
          const cost = values.cost === undefined ? undefined : Math.round(Number(values.cost.replace(/^\$/, '')) * 100);
          if (cost !== undefined && !Number.isFinite(cost)) throw new ClientError('--cost is an amount in dollars, like 2.50');
          const task = (await call('POST', '/api/tasks', { agent, room, request, budget_minutes: int(values.minutes, '--minutes'), budget_cents: cost })) as Json;
          print(task, () => `Created task #${task.id} for ${task.assignee} (${task.state}).`);
          return 0;
        }
        if (sub && ['accept', 'done', 'fail', 'decline', 'cancel'].includes(sub)) {
          const id = int(need(args[0], `task ${sub} <id> [note...]`), 'The task id');
          const state = { accept: 'accepted', done: 'done', fail: 'failed', decline: 'declined', cancel: 'cancelled' }[sub as 'accept'];
          const note = args.slice(1).join(' ') || undefined;
          const task = (await call('POST', `/api/tasks/${id}`, { state, note, links: values.link?.map((url) => ({ url })) })) as Json;
          print(task, () => `Task #${task.id} is ${task.state}.`);
          return 0;
        }
        if (sub === 'progress') {
          const id = int(need(args[0], 'task progress <id> <text...>'), 'The task id');
          const task = (await call('POST', `/api/tasks/${id}/progress`, { text: await textArg(args.slice(1), 'task progress <id> <text...>'), percent: int(values.percent, '--percent') })) as Json;
          print(task, () => `Task #${task.id}: ${task.progress?.text}`);
          return 0;
        }
        if (sub === 'ask') {
          const id = int(need(args[0], 'task ask <id> <question...>'), 'The task id');
          const question = (await call('POST', `/api/tasks/${id}/questions`, { question: await textArg(args.slice(1), 'task ask <id> <question...>') })) as Json;
          print(question, () => `Asked ${question.target} (question ${question.id}); the task waits for the answer.`);
          return 0;
        }
        if (sub === 'checkpoint') {
          const id = int(need(args[0], 'task checkpoint <id> <text...>'), 'The task id');
          const task = (await call('POST', `/api/tasks/${id}/checkpoint`, { text: await textArg(args.slice(1), 'task checkpoint <id> <text...>') })) as Json;
          print(task, () => `Checkpoint saved on task #${task.id}.`);
          return 0;
        }
        throw new ClientError('Usage: orco task <id> | new | accept | done | fail | decline | cancel | progress | checkpoint | ask (orco --help)');
      }
      case 'answer': {
        const id = int(need(rest[0], 'answer <question-id> <answer...>'), 'The question id');
        const question = (await call('POST', `/api/questions/${id}/answer`, { answer: await textArg(rest.slice(1), 'answer <question-id> <answer...>') })) as Json;
        print(question, () => `Answered question ${question.id}; ${question.asker} has been told.`);
        return 0;
      }
      case 'tickets': {
        const params = new URLSearchParams();
        if (rest[0]) params.set('project', rest[0]);
        if (values.assignee) {
          const me = values.assignee === 'me' ? ((await call('GET', '/api/me')) as Json).name : values.assignee;
          params.set('assignee', me);
        }
        if (values.status) params.set('status', values.status);
        else if (!values.all) params.set('open', '1');
        const tickets = (await call('GET', `/api/tickets?${params}`)) as Json[];
        print(tickets, () => (tickets.length ? tickets.map(formatTicket).join('\n') : 'No tickets.'));
        return 0;
      }
      case 'ticket': {
        const [sub, ...args] = rest;
        if (sub === 'new') {
          const project = need(args[0], 'ticket new <project> <title...>');
          const title = await textArg(args.slice(1), 'ticket new <project> <title...>');
          const written = (await call('POST', `/api/projects/${enc(project)}/tickets`, {
            title,
            description: values.description,
            assignee: values.assignee,
            priority: values.priority,
            labels: values.label,
          })) as Json;
          print(written, () => `Filed ${written.ticket.ref}: ${written.ticket.title}${written.warning ? `\n${written.warning}` : ''}`);
          return 0;
        }
        if (sub === 'move') {
          const ref = need(args[0], 'ticket move <ref> <status...>');
          const status = need(args.slice(1).join(' '), 'ticket move <ref> <status...>');
          const written = (await call('POST', `/api/tickets/${enc(ref)}`, { status })) as Json;
          print(written, () => `${written.ticket.ref} is ${written.ticket.status.name}.`);
          return 0;
        }
        if (sub === 'comment') {
          const ref = need(args[0], 'ticket comment <ref> <text...>');
          const ticket = (await call('POST', `/api/tickets/${enc(ref)}/comments`, { text: await textArg(args.slice(1), 'ticket comment <ref> <text...>') })) as Json;
          print(ticket, () => `Commented on ${ticket.ref}.`);
          return 0;
        }
        if (sub === 'claim') {
          const ref = need(args[0], 'ticket claim <ref>');
          const ticket = (await call('POST', `/api/tickets/${enc(ref)}/claim`, {})) as Json;
          print(ticket, () => `${ticket.ref} is yours (${ticket.status.name}).`);
          return 0;
        }
        const ticket = (await call('GET', `/api/tickets/${enc(need(sub, 'ticket <ref>'))}`)) as Json;
        print(ticket, () => formatTicketDetail(ticket));
        return 0;
      }
      case 'api': {
        const method = need(rest[0], 'api <GET|POST|DELETE> <path> [json|-]').toUpperCase();
        if (!['GET', 'POST', 'DELETE'].includes(method)) throw new ClientError('The method is GET, POST or DELETE');
        const path = need(rest[1], 'api <GET|POST|DELETE> <path> [json|-]');
        const rawBody = rest[2] === '-' ? await io.stdin() : rest[2];
        let body: unknown;
        if (rawBody !== undefined) {
          try {
            body = JSON.parse(rawBody);
          } catch {
            throw new ClientError('The body must be JSON');
          }
        }
        const result = await call(method, path.startsWith('/api') || path.startsWith('/hooks') ? path : `/api${path.startsWith('/') ? '' : '/'}${path}`, body);
        io.out(typeof result === 'string' ? result : JSON.stringify(result, null, 2));
        return 0;
      }
      default:
        io.err(CLIENT_USAGE);
        return 1;
    }
  } catch (err) {
    if (err instanceof ClientError) {
      io.err(err.message);
      return err.exitCode;
    }
    throw err;
  }
}

/** Reads all of stdin (for "-" arguments and login). */
export function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return Promise.resolve('');
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => (data += chunk));
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', reject);
  });
}
