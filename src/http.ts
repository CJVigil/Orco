import { toNodeHandler } from '@modelcontextprotocol/node';
import { createMcpHandler } from '@modelcontextprotocol/server';
import express, { type NextFunction, type Request, type Response } from 'express';
import { buildMcpServer } from './mcp.js';
import { OrcoError, type Participant, type Store } from './store.js';

declare module 'express-serve-static-core' {
  interface Request {
    participant?: Participant;
  }
}

const STATUS: Record<OrcoError['code'], number> = { invalid: 400, not_found: 404, forbidden: 403, conflict: 409 };

function authenticate(store: Store) {
  return (req: Request, res: Response, next: NextFunction) => {
    const match = /^Bearer (\S+)$/.exec(req.headers.authorization ?? '');
    const participant = match ? store.authenticate(match[1]!) : null;
    if (!participant) {
      res.status(401).set('WWW-Authenticate', 'Bearer').json({ error: 'Missing or invalid token' });
      return;
    }
    req.participant = participant;
    Object.assign(req, { auth: { token: match![1]!, clientId: participant.name, scopes: [] } });
    next();
  };
}

function optionalInt(value: unknown): number | undefined {
  if (value === undefined || value === '') return undefined;
  const n = Number(value);
  if (!Number.isInteger(n)) throw new OrcoError('invalid', `Expected an integer, got ${String(value)}`);
  return n;
}

export function createApp(store: Store) {
  const app = express();
  const mcp = createMcpHandler(({ requestInfo, authInfo }) => {
    const participant = authInfo ? store.participantByName(authInfo.clientId) : null;
    if (!participant) throw new Error(`Unauthenticated MCP request to ${requestInfo?.url ?? 'unknown'}`);
    return buildMcpServer(store, participant);
  });
  const mcpNode = toNodeHandler(mcp);

  app.get('/healthz', (_req, res) => {
    res.json({ ok: true });
  });

  app.all('/mcp', authenticate(store), (req, res) => {
    void mcpNode(req, res);
  });

  const api = express.Router();
  api.use(authenticate(store), express.json({ limit: '64kb' }));

  api.get('/me', (req, res) => {
    const me = req.participant!;
    res.json({ name: me.name, kind: me.kind, owner: store.ownerName(me) });
  });
  api.get('/participants', (_req, res) => {
    res.json(store.listParticipants().map((p) => ({ name: p.name, kind: p.kind, owner: p.owner })));
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
        threadId: optionalInt(req.query.thread_id),
        limit: optionalInt(req.query.limit),
      }),
    );
  });
  api.post('/messages', (req, res) => {
    const { room, text, thread_id } = req.body ?? {};
    res.status(201).json(store.post(req.participant!, String(room ?? ''), String(text ?? ''), optionalInt(thread_id)));
  });

  app.use('/api', api);

  app.use((err: unknown, _req: Request, res: Response, next: NextFunction) => {
    if (res.headersSent) return next(err);
    if (err instanceof OrcoError) {
      res.status(STATUS[err.code]).json({ error: err.message, code: err.code });
      return;
    }
    console.error(err);
    res.status(500).json({ error: 'Internal error' });
  });

  return { app, close: () => mcp.close() };
}
