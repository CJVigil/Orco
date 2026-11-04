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

const fill = (prevention: string) =>
  [
    '## Timeline',
    '09:02 CET disk full alert; 09:20 CET writes failing; 09:41 CET space freed.',
    '## Impact',
    'Uploads failed for every shop for 39 minutes.',
    '## Root cause',
    'Log rotation was off on the new volume, so logs filled the disk.',
    '## Fix',
    'Freed space and turned rotation on.',
    '## Prevention',
    prevention,
    '## Owner',
    'carlos',
  ].join('\n');

describe('incident tickets (#114)', () => {
  it('opens from a message, refuses to close without its postmortem, and lists incidents by tag', () => {
    const store = new Store(openDatabase(':memory:'));
    const carlos = store.createUser('carlos').participant;
    const bot = store.createAgent('carlos', 'carlos-bot').participant;
    store.createProject(carlos, 'ops');
    const alert = store.post(bot, 'ops/general', 'ALERT: /data is 100% full on store-1');
    const incident = store.incidents.open(carlos, 'ops', { title: 'Uploads failed: disk full', messageId: alert.id, tags: ['storage'] });
    assert.match(incident.description, new RegExp(`^Started from message ${alert.id} in #ops/general`));
    assert.deepEqual(incident.labels.map((l) => l.name).sort(), ['incident', 'storage']);
    assert.match(code(() => store.tickets.update(carlos, incident.ref, { status: 'Done' })), /^conflict: Incident OPS-1 cannot close yet: Timeline is empty; Impact is empty; Root cause is empty/);
    store.tickets.update(bot, incident.ref, { description: fill('- Alert on disk at 80%') });
    assert.match(code(() => store.tickets.update(carlos, incident.ref, { status: 'Done' })), /the prevention step "Alert on disk at 80%" has no follow-up ticket/);
    const follow = store.tickets.create(bot, 'ops', { title: 'Alert on disk at 80%' }).ticket;
    store.tickets.update(bot, incident.ref, { description: fill(`- Alert on disk at 80% (${follow.ref})`) });
    assert.equal(store.tickets.update(carlos, incident.ref, { status: 'Done' }).ticket.status.name, 'Done');
    const listed = store.incidents.list(carlos, 'ops', 'storage');
    assert.deepEqual(listed.map((i) => [i.ref, i.rootCause, i.closed]), [['OPS-1', 'Log rotation was off on the new volume, so logs filled the disk.', true]]);
    assert.deepEqual(store.incidents.list(carlos, 'ops', 'deploy'), []);
  });
});
