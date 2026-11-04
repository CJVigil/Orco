import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { openDatabase } from '../src/db.js';
import { createApp } from '../src/http.js';
import { type Participant, Store } from '../src/store.js';

let store: Store;
let carlos: Participant;
let botToken: string;
let base: string;
let stop: () => Promise<void>;
const data = mkdtempSync(join(tmpdir(), 'orco-hook-'));

before(async () => {
  store = new Store(openDatabase(':memory:'));
  carlos = store.createUser('carlos').participant;
  botToken = store.createAgent('carlos', 'carlos-bot').token;
  store.createProject(carlos, 'shop');
  const { app, close } = createApp(store);
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  stop = async () => {
    await close();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  };
});

after(async () => {
  await stop();
});

function hook(event: string, env: Record<string, string> = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      process.execPath,
      ['integrations/claude-code/hooks/orco-hook.mjs'],
      { env: { PATH: process.env.PATH, CLAUDE_PLUGIN_OPTION_SERVER_URL: base, CLAUDE_PLUGIN_OPTION_TOKEN: botToken, CLAUDE_PLUGIN_DATA: data, ...env } },
      (err, stdout) => (err ? reject(err) : resolve(stdout)),
    );
    child.stdin!.end(JSON.stringify({ hook_event_name: event, session_id: 's1' }));
  });
}

describe('Claude Code plugin hooks (#102)', () => {
  it('opens a session with what waits on the agent, then says only what is new', async () => {
    const { ticket } = store.tickets.create(carlos, 'shop', { title: 'Fix the kiosk', assignee: 'carlos-bot', status: 'In Progress', handoff: 'Printer driver swapped; test the receipt next' });
    const start = JSON.parse(await hook('SessionStart')) as { hookSpecificOutput: { additionalContext: string } };
    assert.match(start.hookSpecificOutput.additionalContext, /Handoff: Printer driver swapped/);
    assert.equal(await hook('UserPromptSubmit'), '', 'silent when nothing is new');
    await new Promise((r) => setTimeout(r, 5));
    store.post(carlos, 'shop/general', '@carlos-bot can you look at the kiosk?');
    store.tickets.comment(carlos, ticket.ref, 'Receipt prints now');
    const line = JSON.parse(await hook('UserPromptSubmit')) as { hookSpecificOutput: { additionalContext: string } };
    assert.match(line.hookSpecificOutput.additionalContext, /1 new mention \(carlos in #shop\/general\), 1 answer on SHO-1/);
    assert.equal(await hook('UserPromptSubmit'), '', 'said once');
  });

  it('is quiet and quick when Orco is down', async () => {
    const t0 = Date.now();
    assert.equal(await hook('UserPromptSubmit', { CLAUDE_PLUGIN_OPTION_SERVER_URL: 'http://127.0.0.1:9' }), '');
    assert.ok(Date.now() - t0 < 3000);
  });
});
