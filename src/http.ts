import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { createMcpHandler } from '@modelcontextprotocol/server';
import express, { type NextFunction, type Request, type Response } from 'express';
import { MAX_ATTACHMENT_BYTES } from './attachments.js';
import { buildMcpServer } from './mcp.js';
import { OAUTH_SCOPE, OAuth } from './oauth.js';
import { oauthRouter } from './oauth-routes.js';
import { Presence } from './presence.js';
import { RateLimiter } from './ratelimit.js';
import { type Message, OrcoError, type Participant, type Store } from './store.js';
import type { Task, TaskState } from './tasks.js';
import type { Approval } from './approvals.js';
import type { Question, QuestionTarget } from './questions.js';
import { byWorkOrder, type Priority, type StatusCategory, type TicketFilter, type TicketInput } from './tickets.js';
import { myWork } from './work.js';

declare module 'express-serve-static-core' {
  interface Request {
    participant?: Participant;
    viaCookie?: boolean;
  }
}

const STATUS: Record<OrcoError['code'], number> = {
  invalid: 400,
  not_found: 404,
  forbidden: 403,
  conflict: 409,
  rate_limited: 429,
};
const COOKIE = 'orco_token';
const TASK_STATES = new Set(['accepted', 'declined', 'done', 'failed', 'cancelled']);
const WEB_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'web');
const HEARTBEAT_MS = 25_000;

function readCookie(header: string | undefined, name: string): string | undefined {
  for (const part of (header ?? '').split(';')) {
    const [key, ...value] = part.trim().split('=');
    if (key === name) return decodeURIComponent(value.join('='));
  }
  return undefined;
}

const STALL_SWEEP_MS = 60_000;

function authenticate(store: Store, presence: Presence, oauth?: OAuth) {
  return (req: Request, res: Response, next: NextFunction) => {
    const bearer = /^Bearer (\S+)$/.exec(req.headers.authorization ?? '')?.[1];
    const token = bearer ?? readCookie(req.headers.cookie, COOKIE);
    const participant = !token ? null : oauth && bearer ? (oauth.verifyAccessToken(bearer) ?? store.authenticate(bearer)) : store.authenticate(token);
    if (!token || !participant) {
      const challenge = oauth
        ? `Bearer resource_metadata="${oauth.issuer}/.well-known/oauth-protected-resource/mcp", scope="${OAUTH_SCOPE}"`
        : 'Bearer';
      res.status(401).set('WWW-Authenticate', challenge).json({ error: 'Missing or invalid token' });
      return;
    }
    req.participant = participant;
    req.viaCookie = bearer === undefined;
    // The bridge uses the agent's token, but its calls say nothing about whether the agent is alive.
    if (req.headers['x-orco-bridge'] !== '1') {
      presence.touch(participant.id);
      store.tasks.touch(participant);
    }
    Object.assign(req, { auth: { token, clientId: participant.name, scopes: [] } });
    next();
  };
}

function rejectCrossSite(req: Request, res: Response, next: NextFunction) {
  if (!req.viaCookie || req.method === 'GET' || req.method === 'HEAD') return next();
  const origin = req.headers.origin;
  const sameOrigin = !origin || new URL(origin).host === req.headers.host;
  if (!sameOrigin || !req.is('application/json')) {
    res.status(403).json({ error: 'Cross-site or non-JSON request refused' });
    return;
  }
  next();
}

function rejectCrossSiteUpload(req: Request, res: Response, next: NextFunction) {
  if (!req.viaCookie) return next();
  const origin = req.headers.origin;
  const sameOrigin = origin ? new URL(origin).host === req.headers.host : req.headers['sec-fetch-site'] === 'same-origin';
  if (!sameOrigin) {
    res.status(403).json({ error: 'Cross-site upload refused' });
    return;
  }
  next();
}

function str(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw new OrcoError('invalid', `${field} must be a string`);
  return value;
}

function nullableStr(value: unknown, field: string): string | null | undefined {
  return value === null ? null : str(value, field);
}

function ticketInput(body: Record<string, unknown> | undefined): TicketInput {
  const b = body ?? {};
  const num = (value: unknown, field: string): number | null | undefined => {
    if (value === undefined || value === null) return value;
    if (typeof value !== 'number') throw new OrcoError('invalid', `${field} must be a number`);
    return value;
  };
  const list = <T extends 'string' | 'number'>(value: unknown, field: string, type: T) => {
    if (value === undefined) return undefined;
    if (!Array.isArray(value) || value.some((v) => typeof v !== type || (type === 'number' && !Number.isInteger(v)))) {
      throw new OrcoError('invalid', `${field} must be a list of ${type === 'number' ? 'ids' : 'strings'}`);
    }
    return value as (T extends 'number' ? number : string)[];
  };
  if (b.labels !== undefined && (!Array.isArray(b.labels) || b.labels.some((l) => typeof l !== 'string'))) {
    throw new OrcoError('invalid', 'labels must be a list of names');
  }
  const cycle = b.cycle === 'current' ? 'current' : num(b.cycle, 'cycle');
  return {
    title: str(b.title, 'title'),
    description: str(b.description, 'description'),
    status: str(b.status, 'status'),
    priority: str(b.priority, 'priority') as Priority | undefined,
    estimate: num(b.estimate, 'estimate'),
    dueDate: nullableStr(b.dueDate, 'dueDate'),
    assignee: nullableStr(b.assignee, 'assignee'),
    labels: b.labels as string[] | undefined,
    milestone: nullableStr(b.milestone, 'milestone'),
    cycle,
    parent: nullableStr(b.parent, 'parent'),
    sort: num(b.sort, 'sort') ?? undefined,
    handoff: str(b.handoff, 'handoff'),
    criteriaAdd: list(b.criteriaAdd, 'criteriaAdd', 'string'),
    criteriaDone: list(b.criteriaDone, 'criteriaDone', 'number'),
    criteriaUndone: list(b.criteriaUndone, 'criteriaUndone', 'number'),
    criteriaRemove: list(b.criteriaRemove, 'criteriaRemove', 'number'),
    blockedByAdd: list(b.blockedByAdd, 'blockedByAdd', 'string'),
    blockedByRemove: list(b.blockedByRemove, 'blockedByRemove', 'string'),
  };
}

/** A retry-safe key from the Idempotency-Key header or an idempotency_key body field. */
function idempotencyKey(req: Request): string | undefined {
  const header = req.headers['idempotency-key'];
  if (typeof header === 'string') return header;
  return str(req.body?.idempotency_key, 'idempotency_key');
}

function optionalInt(value: unknown): number | undefined {
  if (value === undefined || value === '') return undefined;
  const n = Number(value);
  if (!Number.isInteger(n)) throw new OrcoError('invalid', `Expected an integer, got ${String(value)}`);
  return n;
}

export interface AppOptions {
  presence?: Presence;
  publicUrl?: string;
  now?: () => number;
}

export function createApp(store: Store, options: AppOptions = {}) {
  const presence = options.presence ?? new Presence();
  const oauth = options.publicUrl ? new OAuth(store, options.publicUrl) : undefined;
  const logins = new RateLimiter(10, 15 * 60_000, options.now);
  const registrations = new RateLimiter(20, 3600_000, options.now);
  const app = express();
  app.disable('x-powered-by');
  const mcp = createMcpHandler(
    ({ requestInfo, authInfo }) => {
      const participant = authInfo ? store.participantByName(authInfo.clientId) : null;
      if (!participant) throw new Error(`Unauthenticated MCP request to ${requestInfo?.url ?? 'unknown'}`);
      return buildMcpServer(store, presence, participant);
    },
    { maxRequestBodySize: 16 * 1024 * 1024 },
  );
  const mcpNode = toNodeHandler(mcp);
  const auth = authenticate(store, presence);
  const mcpAuth = authenticate(store, presence, oauth);

  const withStatus = (viewer: Participant, people: (Participant & { owner: string | null })[]) => {
    const activity = store.tasks.activity(viewer);
    return people.map((p) => ({
      name: p.name,
      kind: p.kind,
      owner: p.owner,
      status: presence.status(p.id),
      working: activity.get(p.id) ?? null,
      profile: p.kind === 'agent' ? store.profileOf(p) : null,
    }));
  };

  app.get('/healthz', (_req, res) => {
    res.json({ ok: true });
  });

  if (oauth) {
    app.use((req, res, next) => {
      if (req.path.startsWith('/oauth/')) {
        res.setHeader('Content-Security-Policy', "default-src 'self'; style-src 'self'; img-src 'self' data:; frame-ancestors 'none'");
        res.setHeader('Referrer-Policy', 'same-origin');
      }
      next();
    });
    app.use(oauthRouter(store, oauth, logins, registrations));
  }

  app.all('/mcp', mcpAuth, (req, res) => {
    void mcpNode(req, res);
  });

  app.post('/api/session', express.json({ limit: '4kb' }), (req, res) => {
    const ip = req.ip ?? 'unknown';
    if (logins.blocked(ip)) {
      res.status(429).json({ error: 'Too many failed sign-ins. Wait 15 minutes and try again.' });
      return;
    }
    const token = String(req.body?.token ?? '');
    const participant = store.authenticate(token);
    if (!participant || participant.kind !== 'user') {
      logins.hit(ip);
      res.status(401).json({ error: 'That is not a valid user token' });
      return;
    }
    res.cookie(COOKIE, token, {
      httpOnly: true,
      sameSite: 'strict',
      secure: req.secure,
      path: '/',
      maxAge: 30 * 24 * 3600 * 1000,
    });
    res.json({ name: participant.name });
  });

  app.delete('/api/session', (_req, res) => {
    res.clearCookie(COOKIE, { path: '/' });
    res.status(204).end();
  });

  const api = express.Router();
  api.use(auth, express.json({ limit: '64kb' }), rejectCrossSite);

  api.get('/me', (req, res) => {
    const me = req.participant!;
    res.json({ name: me.name, kind: me.kind, owner: store.ownerName(me) });
  });
  api.get('/participants', (req, res) => {
    const project = typeof req.query.project === 'string' && req.query.project ? req.query.project : undefined;
    res.json(withStatus(req.participant!, store.members(req.participant!, project)));
  });
  api.get('/projects', (req, res) => {
    res.json(store.listProjects(req.participant!));
  });
  api.post('/projects', (req, res) => {
    res.status(201).json(store.createProject(req.participant!, String(req.body?.name ?? '')));
  });
  api.post('/projects/:project/members', (req, res) => {
    store.addMember(req.participant!, String(req.params.project), String(req.body?.user ?? ''));
    res.status(204).end();
  });
  api.get('/rooms', (req, res) => {
    const project = typeof req.query.project === 'string' ? req.query.project : undefined;
    res.json(store.listRooms(req.participant!, project));
  });
  api.post('/projects/:project/rooms', (req, res) => {
    res.status(201).json(store.createRoom(req.participant!, String(req.params.project), String(req.body?.name ?? '')));
  });
  api.get('/messages', (req, res) => {
    res.json(
      store.read(req.participant!, String(req.query.room ?? ''), {
        sinceId: optionalInt(req.query.since_id),
        beforeId: optionalInt(req.query.before_id),
        threadId: optionalInt(req.query.thread_id),
        limit: optionalInt(req.query.limit),
        topLevel: req.query.top_level === '1',
      }),
    );
  });
  api.post('/messages', (req, res) => {
    const { room, text, thread_id, attachment_ids } = req.body ?? {};
    const ids = Array.isArray(attachment_ids) ? attachment_ids.map((id: unknown) => optionalInt(id) ?? NaN) : [];
    if (ids.some((id) => Number.isNaN(id))) throw new OrcoError('invalid', 'attachment_ids must be integers');
    const key = idempotencyKey(req);
    res.status(201).json(
      store.once(req.participant!, key, 'message', (id) => store.message(id), () => {
        const message = store.post(req.participant!, String(room ?? ''), String(text ?? ''), optionalInt(thread_id), { attachmentIds: ids });
        return { id: message.id, result: message };
      }),
    );
  });
  api.get('/attachments/:id', (req, res) => {
    const id = optionalInt(req.params.id);
    if (id === undefined) throw new OrcoError('invalid', 'Expected an image id');
    const image = store.attachments.get(req.participant!, id);
    res.set({
      'Content-Type': image.mime,
      'Content-Length': String(image.size),
      'Content-Disposition': `inline; filename="${image.name.replace(/"/g, '')}"`,
      'Content-Security-Policy': "default-src 'none'; sandbox",
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'private, max-age=31536000, immutable',
      ETag: `"${image.sha256}"`,
    });
    res.send(image.data);
  });

  api.post('/tasks/:id/questions', (req, res) => {
    const id = optionalInt(req.params.id);
    if (id === undefined) throw new OrcoError('invalid', 'Expected a task id');
    const to = str(req.body?.to, 'to') as QuestionTarget | undefined;
    res.status(201).json(store.questions.ask(req.participant!, id, str(req.body?.question, 'question') ?? '', to));
  });
  api.get('/questions', (req, res) => {
    res.json(store.questions.waitingOn(req.participant!));
  });
  api.get('/questions/:id', (req, res) => {
    const id = optionalInt(req.params.id);
    if (id === undefined) throw new OrcoError('invalid', 'Expected a question id');
    res.json(store.questions.get(req.participant!, id));
  });
  api.post('/questions/:id/answer', (req, res) => {
    const id = optionalInt(req.params.id);
    if (id === undefined) throw new OrcoError('invalid', 'Expected a question id');
    res.json(store.questions.answer(req.participant!, id, str(req.body?.answer, 'answer') ?? ''));
  });
  api.post('/questions/:id/resume', (req, res) => {
    const id = optionalInt(req.params.id);
    if (id === undefined) throw new OrcoError('invalid', 'Expected a question id');
    res.json({ resumed: store.questions.claimResume(req.participant!, id) });
  });

  api.get('/projects/:project/notes', (req, res) => {
    res.json(store.notes.list(req.participant!, String(req.params.project)));
  });
  api.post('/projects/:project/notes', (req, res) => {
    const id = req.body?.id === undefined || req.body?.id === null ? undefined : optionalInt(req.body.id);
    res.json(
      store.notes.save(req.participant!, String(req.params.project), { id, title: str(req.body?.title, 'title') ?? '', body: str(req.body?.body, 'body') ?? '' }),
    );
  });
  api.delete('/projects/:project/notes/:id', (req, res) => {
    const id = optionalInt(req.params.id);
    if (id === undefined) throw new OrcoError('invalid', 'Expected a note id');
    store.notes.delete(req.participant!, String(req.params.project), id);
    res.status(204).end();
  });
  api.post('/tasks/:id/progress', (req, res) => {
    const id = optionalInt(req.params.id);
    if (id === undefined) throw new OrcoError('invalid', 'Expected a task id');
    const percent = req.body?.percent === undefined || req.body?.percent === null ? null : optionalInt(req.body.percent);
    res.json(store.tasks.reportProgress(req.participant!, id, str(req.body?.text, 'text') ?? '', percent));
  });
  api.post('/tasks/:id/reassign', (req, res) => {
    const id = optionalInt(req.params.id);
    if (id === undefined) throw new OrcoError('invalid', 'Expected a task id');
    res.json(store.tasks.reassign(req.participant!, id, str(req.body?.agent, 'agent') ?? '', str(req.body?.note, 'note')));
  });
  api.get('/tasks/:id/trail', (req, res) => {
    const id = optionalInt(req.params.id);
    if (id === undefined) throw new OrcoError('invalid', 'Expected a task id');
    res.json(store.audit.trailForTask(req.participant!, id));
  });
  api.post('/tasks/:id/plans', (req, res) => {
    const id = optionalInt(req.params.id);
    if (id === undefined) throw new OrcoError('invalid', 'Expected a task id');
    const to = str(req.body?.to, 'to') as 'owner' | 'requester' | undefined;
    res.status(201).json(store.questions.proposePlan(req.participant!, id, str(req.body?.plan, 'plan') ?? '', to));
  });
  api.post('/questions/:id/decide', (req, res) => {
    const id = optionalInt(req.params.id);
    if (id === undefined) throw new OrcoError('invalid', 'Expected a question id');
    if (typeof req.body?.approve !== 'boolean') throw new OrcoError('invalid', 'approve must be true or false');
    res.json(store.questions.decidePlan(req.participant!, id, { approve: req.body.approve, plan: str(req.body?.plan, 'plan'), note: str(req.body?.note, 'note') }));
  });
  api.post('/flags', (req, res) => {
    const messageId = req.body?.message_id === undefined ? undefined : optionalInt(req.body.message_id);
    res.status(201).json(store.flags.flag(req.participant!, { messageId, ticket: str(req.body?.ticket, 'ticket') }, str(req.body?.reason, 'reason') ?? ''));
  });
  api.post('/flags/:id/dismiss', (req, res) => {
    const id = optionalInt(req.params.id);
    if (id === undefined) throw new OrcoError('invalid', 'Expected a flag id');
    store.flags.dismiss(req.participant!, id);
    res.status(204).end();
  });
  api.get('/agents/find', (req, res) => {
    const text = (value: unknown) => (typeof value === 'string' && value ? value : undefined);
    res.json(store.findAgents(req.participant!, { skill: text(req.query.skill), project: text(req.query.project) }));
  });
  api.post('/agents/:name/profile', (req, res) => {
    const skills = req.body?.skills;
    if (skills !== undefined && (!Array.isArray(skills) || skills.some((s: unknown) => typeof s !== 'string'))) {
      throw new OrcoError('invalid', 'skills must be a list of strings');
    }
    res.json(store.setProfile(req.participant!, String(req.params.name), { skills, environment: str(req.body?.environment, 'environment') }));
  });
  api.get('/threads/:id/summary', (req, res) => {
    const id = optionalInt(req.params.id);
    if (id === undefined) throw new OrcoError('invalid', 'Expected a thread id');
    store.read(req.participant!, String(req.query.room ?? ''), { threadId: id, limit: 1 });
    res.json(store.threadSummary(id));
  });
  api.post('/threads/:id/summary', (req, res) => {
    const id = optionalInt(req.params.id);
    if (id === undefined) throw new OrcoError('invalid', 'Expected a thread id');
    res.json(store.setThreadSummary(req.participant!, str(req.body?.room, 'room') ?? '', id, str(req.body?.summary, 'summary') ?? ''));
  });

  api.get('/tickets', (req, res) => {
    const q = req.query;
    const text = (value: unknown) => (typeof value === 'string' && value ? value : undefined);
    const cycle = q.cycle === 'current' ? 'current' : optionalInt(q.cycle);
    const filter: TicketFilter = {
      project: text(q.project),
      status: text(q.status),
      categories: text(q.category)?.split(',') as StatusCategory[] | undefined,
      open: q.open === '1',
      assignee: text(q.assignee),
      label: text(q.label),
      milestone: text(q.milestone),
      cycle,
      priority: text(q.priority) as Priority | undefined,
      parent: text(q.parent),
      query: text(q.q),
      limit: optionalInt(q.limit),
    };
    res.json(store.tickets.list(req.participant!, filter));
  });
  api.post('/projects/:project/tickets', (req, res) => {
    const input = ticketInput(req.body);
    res.status(201).json(store.tickets.create(req.participant!, String(req.params.project), { ...input, title: input.title ?? '' }));
  });
  api.get('/tickets/:ref', (req, res) => {
    res.json(store.tickets.get(req.participant!, String(req.params.ref), optionalInt(req.query.since)));
  });
  api.post('/tickets/:ref', (req, res) => {
    res.json(store.tickets.update(req.participant!, String(req.params.ref), ticketInput(req.body)));
  });
  api.post('/tickets/:ref/comments', (req, res) => {
    res.status(201).json(store.tickets.comment(req.participant!, String(req.params.ref), str(req.body?.text, 'text') ?? ''));
  });
  api.post('/tickets/:ref/start', (req, res) => {
    res.json(store.tickets.startTask(req.participant!, String(req.params.ref)));
  });
  api.get('/projects/:project/plan', (req, res) => {
    res.json(store.tickets.plan(req.participant!, String(req.params.project)));
  });
  api.post('/projects/:project/statuses', (req, res) => {
    const { name, category, position } = req.body ?? {};
    res.status(201).json(
      store.tickets.addStatus(req.participant!, String(req.params.project), {
        name: str(name, 'name') ?? '',
        category: str(category, 'category') as StatusCategory,
        position: optionalInt(position),
      }),
    );
  });
  api.post('/projects/:project/statuses/:id', (req, res) => {
    const id = optionalInt(req.params.id);
    if (id === undefined) throw new OrcoError('invalid', 'Expected a status id');
    const { name, category, position } = req.body ?? {};
    res.json(
      store.tickets.updateStatus(req.participant!, String(req.params.project), id, {
        name: str(name, 'name'),
        category: str(category, 'category') as StatusCategory | undefined,
        position: optionalInt(position),
      }),
    );
  });
  api.delete('/projects/:project/statuses/:id', (req, res) => {
    const id = optionalInt(req.params.id);
    const moveTo = optionalInt(req.query.move_to);
    if (id === undefined || moveTo === undefined) throw new OrcoError('invalid', 'Expected a status id and move_to');
    res.json(store.tickets.removeStatus(req.participant!, String(req.params.project), id, moveTo));
  });
  api.post('/projects/:project/labels', (req, res) => {
    res.status(201).json(store.tickets.createLabel(req.participant!, String(req.params.project), str(req.body?.name, 'name') ?? '', str(req.body?.color, 'color')));
  });
  api.delete('/projects/:project/labels/:id', (req, res) => {
    const id = optionalInt(req.params.id);
    if (id === undefined) throw new OrcoError('invalid', 'Expected a label id');
    store.tickets.deleteLabel(req.participant!, String(req.params.project), id);
    res.status(204).end();
  });
  api.post('/projects/:project/milestones', (req, res) => {
    const { name, description, targetDate } = req.body ?? {};
    res.status(201).json(
      store.tickets.createMilestone(req.participant!, String(req.params.project), {
        name: str(name, 'name') ?? '',
        description: str(description, 'description'),
        targetDate: nullableStr(targetDate, 'targetDate'),
      }),
    );
  });
  api.post('/projects/:project/milestones/:id', (req, res) => {
    const id = optionalInt(req.params.id);
    if (id === undefined) throw new OrcoError('invalid', 'Expected a milestone id');
    const { name, description, targetDate } = req.body ?? {};
    res.json(
      store.tickets.updateMilestone(req.participant!, String(req.params.project), id, {
        name: str(name, 'name'),
        description: str(description, 'description'),
        targetDate: nullableStr(targetDate, 'targetDate'),
      }),
    );
  });
  api.delete('/projects/:project/milestones/:id', (req, res) => {
    const id = optionalInt(req.params.id);
    if (id === undefined) throw new OrcoError('invalid', 'Expected a milestone id');
    store.tickets.deleteMilestone(req.participant!, String(req.params.project), id);
    res.status(204).end();
  });
  api.post('/projects/:project/cycles', (req, res) => {
    res.status(201).json(
      store.tickets.createCycle(req.participant!, String(req.params.project), {
        startsOn: str(req.body?.startsOn, 'startsOn'),
        endsOn: str(req.body?.endsOn, 'endsOn'),
      }),
    );
  });
  api.post('/projects/:project/cycles/:id/complete', (req, res) => {
    const id = optionalInt(req.params.id);
    if (id === undefined) throw new OrcoError('invalid', 'Expected a cycle id');
    res.json(store.tickets.completeCycle(req.participant!, String(req.params.project), id));
  });

  api.get('/tasks', (req, res) => {
    const room = typeof req.query.room === 'string' && req.query.room ? req.query.room : undefined;
    res.json(
      store.tasks.list(req.participant!, {
        room,
        requestedByMe: req.query.mine === '1',
        assignedToMe: req.query.assigned === '1',
        open: req.query.open === '1',
        limit: optionalInt(req.query.limit),
      }),
    );
  });
  api.get('/tasks/:id', (req, res) => {
    const id = optionalInt(req.params.id);
    if (id === undefined) throw new OrcoError('invalid', 'Expected a task id');
    res.json(store.tasks.get(req.participant!, id));
  });
  api.post('/tasks', (req, res) => {
    const { agent, room, request } = req.body ?? {};
    const me = req.participant!;
    res.status(201).json(
      store.once(me, idempotencyKey(req), 'task', (id) => store.tasks.get(me, id), () => {
        const task = store.tasks.create(me, { agent: String(agent ?? ''), room: String(room ?? ''), request: String(request ?? '') });
        return { id: task.id, result: task };
      }),
    );
  });
  api.post('/tasks/:id', (req, res) => {
    const id = optionalInt(req.params.id);
    const state = String(req.body?.state ?? '');
    if (id === undefined || !TASK_STATES.has(state)) throw new OrcoError('invalid', 'Expected a task id and a valid state');
    res.json(store.tasks.update(req.participant!, id, state as TaskState, req.body?.note));
  });

  api.get('/locks', (req, res) => {
    const project = typeof req.query.project === 'string' && req.query.project ? req.query.project : undefined;
    res.json(store.locks.list(req.participant!, project));
  });
  api.post('/locks', (req, res) => {
    const { project, name, ttl_seconds, note } = req.body ?? {};
    res.status(201).json(
      store.locks.acquire(req.participant!, String(project ?? ''), String(name ?? ''), optionalInt(ttl_seconds) ?? 300, note),
    );
  });
  api.post('/locks/release', (req, res) => {
    const { project, name, force } = req.body ?? {};
    store.locks.release(req.participant!, String(project ?? ''), String(name ?? ''), force === true);
    res.status(204).end();
  });

  api.get('/my-work', (req, res) => {
    res.json(myWork(store, req.participant!));
  });
  api.get('/inbox', (req, res) => {
    const me = req.participant!;
    const approvals = store.approvals.list(me, { pending: true, forMe: true });
    const tasks = me.kind === 'user' ? store.tasks.list(me, { forMyAgents: true, open: true }) : store.tasks.list(me, { assignedToMe: true, open: true });
    const mentions = store.recentMentions(me);
    const questions = store.questions.waitingOn(me);
    const flags = store.flags.pendingFor(me);
    const stalled = store.tasks.stalledFor(me).filter((t) => t.assignee !== me.name);
    const tickets = store.tickets.list(me, { assignee: me.name, open: true, limit: 100 }).sort(byWorkOrder);
    res.json({
      approvals,
      tasks,
      tickets,
      questions,
      flags,
      stalled,
      mentions,
      counts: {
        approvals: approvals.length,
        questions: questions.length,
        flags: flags.length,
        stalled: stalled.length,
        // Question pings live in `questions` while open and need nothing once answered, so they never count here.
        unseenMentions: mentions.filter((m) => !m.seen && m.approval?.state !== 'pending' && !m.question).length,
      },
    });
  });
  api.post('/inbox/seen', (req, res) => {
    const upTo = optionalInt(req.body?.up_to_id);
    if (upTo === undefined) throw new OrcoError('invalid', 'Expected up_to_id');
    store.markMentionsSeen(req.participant!, upTo);
    res.status(204).end();
  });
  api.get('/search', (req, res) => {
    res.json(store.search(req.participant!, String(req.query.q ?? ''), optionalInt(req.query.limit)));
  });

  api.get('/approvals', (req, res) => {
    const room = typeof req.query.room === 'string' && req.query.room ? req.query.room : undefined;
    res.json(
      store.approvals.list(req.participant!, {
        room,
        pending: req.query.pending === '1',
        forMe: req.query.mine === '1',
        limit: optionalInt(req.query.limit),
      }),
    );
  });
  api.post('/approvals', (req, res) => {
    const { room, summary, details, ttl_seconds, approver } = req.body ?? {};
    res.status(201).json(
      store.approvals.request(req.participant!, {
        room: String(room ?? ''),
        summary: String(summary ?? ''),
        details: typeof details === 'string' ? details : undefined,
        approver: approver === 'owner' || approver === 'members' ? approver : undefined,
        ttlSeconds: optionalInt(ttl_seconds),
      }),
    );
  });
  api.post('/approvals/:id', (req, res) => {
    const id = optionalInt(req.params.id);
    const decision = req.body?.decision;
    if (id === undefined || (decision !== 'approved' && decision !== 'denied')) {
      throw new OrcoError('invalid', 'Expected an approval id and decision "approved" or "denied"');
    }
    const note = typeof req.body?.note === 'string' ? req.body.note : undefined;
    res.json(store.approvals.decide(req.participant!, id, decision, note, { alwaysAllow: req.body?.always_allow === true }));
  });

  api.get('/agents', (req, res) => {
    const connections = oauth && req.participant!.kind === 'user' ? oauth.connections(req.participant!) : [];
    res.json(store.myAgents(req.participant!).map((agent) => ({ ...agent, connections: connections.filter((c) => c.agent === agent.name) })));
  });
  api.post('/connections/:id/revoke', (req, res) => {
    const id = optionalInt(req.params.id);
    if (!oauth || id === undefined || req.participant!.kind !== 'user') throw new OrcoError('not_found', 'No such connection');
    oauth.revokeConnection(req.participant!, id);
    res.status(204).end();
  });
  api.post('/agents/:name/policy', (req, res) => {
    res.json(store.setTaskPolicy(req.participant!, String(req.params.name), req.body?.policy));
  });
  api.post('/agents/:name/trust', (req, res) => {
    res.json(store.setTrust(req.participant!, String(req.params.name), String(req.body?.user ?? ''), req.body?.trusted !== false));
  });

  api.get('/audit', (req, res) => {
    const project = typeof req.query.project === 'string' && req.query.project ? req.query.project : undefined;
    const entries = store.audit.list(req.participant!, {
      project,
      sinceId: optionalInt(req.query.since_id),
      limit: optionalInt(req.query.limit),
    });
    if (req.query.format === 'jsonl') {
      const name = `orco-audit-${project ?? 'all'}-${new Date(store.now()).toISOString().slice(0, 10)}.jsonl`;
      res.set('Content-Type', 'application/x-ndjson; charset=utf-8');
      res.set('Content-Disposition', `attachment; filename="${name}"`);
      res.send(entries.map((entry) => JSON.stringify(entry)).join('\n') + (entries.length ? '\n' : ''));
      return;
    }
    res.json(entries);
  });

  api.get('/events', (req, res) => {
    const me = req.participant!;
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    const send = (event: string, data: unknown) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    const onMessage = (message: Message) => {
      if (store.canSee(me, message.projectId)) send('message', message);
    };
    const onStructure = () => send('structure', {});
    const onTask = (task: Task) => {
      if (store.canSee(me, task.projectId)) send('task', task);
    };
    const onApproval = (approval: Approval) => {
      if (store.canSee(me, approval.projectId)) send('approval', approval);
    };
    const onQuestion = (question: Question) => {
      if (store.canSee(me, question.projectId)) send('question', question);
    };
    const onLock = ({ projectId }: { projectId: number }) => {
      if (store.canSee(me, projectId)) send('locks', { projectId });
    };
    const onTicket = (event: { projectId: number; ref: string | null }) => {
      if (store.canSee(me, event.projectId)) send('ticket', event);
    };
    const onNotes = ({ projectId }: { projectId: number }) => {
      if (store.canSee(me, projectId)) send('notes', { projectId });
    };
    const onFlag = ({ ownerId }: { ownerId: number | null }) => {
      if (ownerId === me.id) send('flag', {});
    };
    const onSummary = (event: { projectId: number | null; threadId: number }) => {
      if (store.canSee(me, event.projectId)) send('summary', event);
    };
    const onPresence = () => send('presence', {});
    store.events.on('ticket', onTicket);
    store.events.on('notes', onNotes);
    store.events.on('flag', onFlag);
    store.events.on('summary', onSummary);
    store.events.on('message', onMessage);
    store.events.on('structure', onStructure);
    store.events.on('task', onTask);
    store.events.on('lock', onLock);
    store.events.on('approval', onApproval);
    store.events.on('question', onQuestion);
    presence.events.on('change', onPresence);
    const release = presence.hold(me.id, req.query.bridge === '1' && me.kind === 'agent' ? 'bridges' : 'streams');
    const heartbeat = setInterval(() => res.write(': ping\n\n'), HEARTBEAT_MS);
    send('ready', { name: me.name });
    req.on('close', () => {
      clearInterval(heartbeat);
      store.events.off('ticket', onTicket);
      store.events.off('notes', onNotes);
      store.events.off('flag', onFlag);
      store.events.off('summary', onSummary);
      store.events.off('message', onMessage);
      store.events.off('structure', onStructure);
      store.events.off('task', onTask);
      store.events.off('lock', onLock);
      store.events.off('approval', onApproval);
      store.events.off('question', onQuestion);
      presence.events.off('change', onPresence);
      release();
    });
  });

  app.post(
    '/api/attachments',
    auth,
    rejectCrossSiteUpload,
    express.raw({ type: () => true, limit: MAX_ATTACHMENT_BYTES + 1 }),
    (req, res) => {
      const data = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
      const name = typeof req.query.name === 'string' ? req.query.name : undefined;
      res.status(201).json(store.attachments.upload(req.participant!, String(req.query.room ?? ''), data, name));
    },
  );

  app.use('/api', api);

  app.use(
    express.static(WEB_DIR, {
      setHeaders: (res) => {
        res.setHeader(
          'Content-Security-Policy',
          "default-src 'self'; img-src 'self' data: blob:; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'",
        );
        res.setHeader('X-Content-Type-Options', 'nosniff');
        res.setHeader('Referrer-Policy', 'no-referrer');
      },
    }),
  );

  app.use((err: unknown, _req: Request, res: Response, next: NextFunction) => {
    if (res.headersSent) return next(err);
    if (err instanceof OrcoError) {
      res.status(STATUS[err.code]).json({ error: err.message, code: err.code });
      return;
    }
    const status = (err as { status?: unknown }).status;
    if (typeof status === 'number' && status >= 400 && status < 500) {
      res.status(status).json({ error: status === 413 ? 'That is too large' : 'Bad request' });
      return;
    }
    console.error(err);
    res.status(500).json({ error: 'Internal error' });
  });

  // Report tasks whose agents have gone quiet. Cheap: one query a minute.
  const stallSweep = setInterval(() => store.tasks.sweepStalled(), STALL_SWEEP_MS);
  stallSweep.unref();
  return {
    app,
    presence,
    oauth,
    close: () => {
      clearInterval(stallSweep);
      return mcp.close();
    },
  };
}
