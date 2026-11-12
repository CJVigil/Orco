import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { MessageChannel, receiveMessageOnPort, Worker } from 'node:worker_threads';
import { OrcoError } from '../errors.js';
import type { Backend } from './backends.js';
import type { Target } from './target.js';

/*
 * A synchronous handle on a PostgreSQL or MongoDB backend (#148). Orco's store is synchronous (it was
 * written for node:sqlite), so each call is posted to a worker thread that owns the connection, and
 * this thread waits for the answer with Atomics.wait. That blocks the event loop for the round trip,
 * exactly as a SQLite write blocks it today.
 */
export class SyncRemote {
  private readonly worker: Worker;
  private readonly flag = new SharedArrayBuffer(4);
  private readonly signal = new Int32Array(this.flag);
  private closed = false;

  constructor(
    readonly target: Exclude<Target, { kind: 'sqlite' }>,
    private readonly timeoutMs = Number(process.env.ORCO_DATABASE_TIMEOUT_MS) || 30_000,
  ) {
    const ts = new URL('./worker.ts', import.meta.url);
    const workerData = { target, flag: this.flag };
    // From source (tests, npm run dev) the worker needs tsx's loader registered inside it; built, it is plain JS.
    const entry = existsSync(fileURLToPath(ts)) ? ts.href : new URL('./worker.js', import.meta.url).href;
    const tsx = entry === ts.href ? pathToFileURL(join(dirname(createRequire(import.meta.url).resolve('tsx/package.json')), 'dist/esm/api/index.mjs')).href : null;
    // If the worker cannot start, it answers every call with why, instead of leaving the caller waiting.
    const boot = `
      const { parentPort } = require('node:worker_threads');
      (${tsx ? `import(${JSON.stringify(tsx)}).then((m) => { m.register(); return import(${JSON.stringify(entry)}); })` : `import(${JSON.stringify(entry)})`}).catch((err) => {
        const signal = new Int32Array(require('node:worker_threads').workerData.flag);
        parentPort.on('message', (msg) => {
          msg.port.postMessage({ ok: false, error: 'the database worker did not start: ' + err.message });
          Atomics.store(signal, 0, 1);
          Atomics.notify(signal, 0);
        });
      });`;
    this.worker = new Worker(boot, { eval: true, workerData });
    // The worker never keeps the process alive on its own; the server's HTTP listener does.
    this.worker.unref();
    this.call('open');
  }

  call<K extends keyof Backend | 'open'>(method: K, ...args: unknown[]): K extends keyof Backend ? Awaited<ReturnType<Backend[K]>> : null {
    if (this.closed) throw new OrcoError('unavailable', 'The database connection is closed');
    const { port1, port2 } = new MessageChannel();
    Atomics.store(this.signal, 0, 0);
    this.worker.postMessage({ port: port2, method, args }, [port2]);
    const waited = Atomics.wait(this.signal, 0, 0, this.timeoutMs);
    const msg = receiveMessageOnPort(port1)?.message as { ok: true; value: unknown } | { ok: false; error: string } | undefined;
    port1.close();
    if (!msg) {
      throw new OrcoError('unavailable', waited === 'timed-out' ? `The ${this.target.kind} database did not answer within ${this.timeoutMs / 1000}s` : `The ${this.target.kind} database connection failed`);
    }
    if (!msg.ok) throw new OrcoError('unavailable', `${this.target.kind === 'postgres' ? 'PostgreSQL' : 'MongoDB'}: ${msg.error}`);
    return msg.value as never;
  }

  close(): void {
    if (this.closed) return;
    try {
      this.call('close');
    } finally {
      this.closed = true;
      void this.worker.terminate();
    }
  }
}
