import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { createMcpHandler } from '@modelcontextprotocol/server';
import express, { type NextFunction, type Request, type Response } from 'express';
import { buildMcpServer } from './mcp.js';
import { Presence } from './presence.js';
import { type Message, OrcoError, type Participant, type Store } from './store.js';
import type { Task, TaskState } from './tasks.js';
import type { Approval } from './approvals.js';

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

function authenticate(store: Store, presence: Presence) {
  return (req: Request, res: Response, next: NextFunction) => {
    const bearer = /^Bearer (\S+)$/.exec(req.headers.authorization ?? '')?.[1];
    const token = bearer ?? readCookie(req.headers.cookie, COOKIE);
    const participant = token ? store.authenticate(token) : null;
    if (!token || !participant) {
      res.status(401).set('WWW-Authenticate', 'Bearer').json({ error: 'Missing or invalid token' });
      return;
    }
    req.participant = participant;
    req.viaCookie = bearer === undefined;
    if (req.headers['x-orco-bridge'] !== '1') presence.touch(participant.id);
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

function optionalInt(value: unknown): number | undefined {
  if (value === undefined || value === '') return undefined;
  const n = Number(value);
  if (!Number.isInteger(n)) throw new OrcoError('invalid', `Expected an integer, got ${String(value)}`);
  return n;
}

export function createApp(store: Store, presence = new Presence()) {
  const app = express();
  app.disable('x-powered-by');
  const mcp = createMcpHandler(({ requestInfo, authInfo }) => {
    const participant = authInfo ? store.participantByName(authInfo.clientId) : null;
    if (!participant) throw new Error(`Unauthenticated MCP request to ${requestInfo?.url ?? 'unknown'}`);
    return buildMcpServer(store, presence, participant);
  });
  const mcpNode = toNodeHandler(mcp);
  const auth = authenticate(store, presence);

  const withStatus = (people: (Participant & { owner: string | null })[]) =>
    people.map((p) => ({ name: p.name, kind: p.kind, owner: p.owner, status: presence.status(p.id) }));

  app.get('/healthz', (_req, res) => {
    res.json({ ok: true });
  });

  app.all('/mcp', auth, (req, res) => {
    void mcpNode(req, res);
  });

  app.post('/api/session', express.json({ limit: '4kb' }), (req, res) => {
    const token = String(req.body?.token ?? '');
    const participant = store.authenticate(token);
    if (!participant || participant.kind !== 'user') {
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
    res.json(withStatus(store.members(req.participant!, project)));
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
    const { room, text, thread_id } = req.body ?? {};
    res.status(201).json(store.post(req.participant!, String(room ?? ''), String(text ?? ''), optionalInt(thread_id)));
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
    res.status(201).json(
      store.tasks.create(req.participant!, { agent: String(agent ?? ''), room: String(room ?? ''), request: String(request ?? '') }),
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
    res.json(store.myAgents(req.participant!));
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
    const onLock = ({ projectId }: { projectId: number }) => {
      if (store.canSee(me, projectId)) send('locks', { projectId });
    };
    const onPresence = () => send('presence', {});
    store.events.on('message', onMessage);
    store.events.on('structure', onStructure);
    store.events.on('task', onTask);
    store.events.on('lock', onLock);
    store.events.on('approval', onApproval);
    presence.events.on('change', onPresence);
    const release = presence.hold(me.id, req.query.bridge === '1' && me.kind === 'agent' ? 'bridges' : 'streams');
    const heartbeat = setInterval(() => res.write(': ping\n\n'), HEARTBEAT_MS);
    send('ready', { name: me.name });
    req.on('close', () => {
      clearInterval(heartbeat);
      store.events.off('message', onMessage);
      store.events.off('structure', onStructure);
      store.events.off('task', onTask);
      store.events.off('lock', onLock);
      store.events.off('approval', onApproval);
      presence.events.off('change', onPresence);
      release();
    });
  });

  app.use('/api', api);

  app.use(
    express.static(WEB_DIR, {
      setHeaders: (res) => {
        res.setHeader(
          'Content-Security-Policy',
          "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'",
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
    console.error(err);
    res.status(500).json({ error: 'Internal error' });
  });

  return { app, presence, close: () => mcp.close() };
}
