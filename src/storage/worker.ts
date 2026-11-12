import { parentPort, workerData } from 'node:worker_threads';
import type { MessagePort } from 'node:worker_threads';
import { type Backend, openBackend } from './backends.js';
import type { Target } from './target.js';

/*
 * The worker side of remote.ts (#148): it owns the PostgreSQL or MongoDB connection and runs one call
 * at a time. The answer goes on the port, then the shared flag is set and the waiting thread woken.
 */
const { target, flag } = workerData as { target: Exclude<Target, { kind: 'sqlite' }>; flag: SharedArrayBuffer };
const signal = new Int32Array(flag);
let backend: Backend | null = null;

parentPort!.on('message', async (msg: { port: MessagePort; method: keyof Backend | 'open'; args: unknown[] }) => {
  let reply: { ok: true; value: unknown } | { ok: false; error: string; stack?: string };
  try {
    if (msg.method === 'open') {
      backend ??= await openBackend(target);
      reply = { ok: true, value: null };
    } else {
      if (!backend) throw new Error('The database connection is not open');
      const fn = backend[msg.method] as (...a: unknown[]) => Promise<unknown>;
      reply = { ok: true, value: await fn(...msg.args) };
      if (msg.method === 'close') backend = null;
    }
  } catch (err) {
    reply = { ok: false, error: (err as Error).message, stack: (err as Error).stack };
  }
  msg.port.postMessage(reply);
  Atomics.store(signal, 0, 1);
  Atomics.notify(signal, 0);
});
