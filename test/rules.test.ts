import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { openDatabase } from '../src/db.js';
import { type OrcoError, Store } from '../src/store.js';

const code = (fn: () => unknown) => {
  try {
    fn();
  } catch (err) {
    return `${(err as OrcoError).code}: ${(err as OrcoError).message}`;
  }
  return 'ok';
};

describe('checked rules (#113)', () => {
  it('blocks an approval whose diff mounts the Docker socket, tells the owner, and lets it through once off', () => {
    const store = new Store(openDatabase(':memory:'));
    const carlos = store.createUser('carlos').participant; // org admin
    const bot = store.createAgent('carlos', 'carlos-bot').participant;
    store.createProject(carlos, 'ops');
    const docker = store.rules.list().find((r) => r.name === 'No Docker socket mounts')!;
    assert.equal(docker.enabled, false, 'examples ship switched off');
    const request = () =>
      store.approvals.request(bot, { room: 'ops/general', summary: 'Add the log shipper', details: '--- a/compose.yml\n+++ b/compose.yml\n+    volumes:\n+      - /var/run/docker.sock:/var/run/docker.sock:ro' });
    assert.equal(code(request), 'ok', 'off: nothing checked');
    store.rules.save(carlos, { id: docker.id, enabled: true, owner: 'carlos' });
    assert.match(code(request), /^conflict: Blocked by the rule "No Docker socket mounts" \(Mounting the Docker socket gives a container root on the host\.\)/);
    const told = store.messagesAfter(carlos, 0, 100).some((m) => m.author === 'orco' && m.text.includes('@carlos') && m.text.includes('No Docker socket mounts'));
    assert.ok(told, 'the owner is told');
    assert.ok(store.audit.list(carlos, { limit: 50 }).some((e) => e.action === 'checked_rule.block'));
    store.rules.save(carlos, { id: docker.id, enabled: false });
    assert.equal(code(request), 'ok', 'turned off, it goes through');
  });

  it('flags a matching code block an agent posts, without blocking it', () => {
    const store = new Store(openDatabase(':memory:'));
    const carlos = store.createUser('carlos').participant;
    const bot = store.createAgent('carlos', 'carlos-bot').participant;
    store.createProject(carlos, 'ops');
    const rule = store.rules.list().find((r) => r.name === 'No skipping hooks')!;
    store.rules.save(carlos, { id: rule.id, enabled: true, owner: 'carlos' });
    const posted = store.post(bot, 'ops/general', 'Pushed with:\n```\ngit commit --no-verify -m wip\n```');
    const flag = store.messagesAfter(carlos, 0, 100).find((m) => m.author === 'orco' && m.threadId === posted.id);
    assert.match(flag?.text ?? '', /@carlos This message matches the checked rule "No skipping hooks"/);
    assert.equal(code(() => store.rules.save(bot as never, { name: 'x', pattern: 'y' })), 'forbidden: Only org admins manage checked rules');
  });
});
