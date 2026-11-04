import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { openDatabase } from '../src/db.js';
import { DEFAULT_SECTIONS, missingSections, scopeTemplate } from '../src/scope.js';
import { type OrcoError, Store } from '../src/store.js';

const code = (fn: () => unknown) => {
  try {
    fn();
  } catch (err) {
    return `${(err as OrcoError).code}: ${(err as OrcoError).message}`;
  }
  return 'ok';
};

function filled(project: string, skip: string[] = []): string {
  return scopeTemplate(project, DEFAULT_SECTIONS)
    .split('\n')
    .flatMap((line) => {
      const title = line.replace(/^## \d+\. /, '');
      return line.startsWith('## ') && !skip.includes(title) ? [line, `Content for ${title}.`] : [line];
    })
    .join('\n');
}

describe('the scope gate (#108)', () => {
  it('holds build tickets in Backlog until every section is written and an admin approves it', () => {
    const store = new Store(openDatabase(':memory:'));
    const carlos = store.createUser('carlos').participant; // the first user is an org admin
    const ana = store.createUser('ana').participant;
    const bot = store.createAgent('ana', 'ana-bot').participant;
    store.scope.setGateNewProjects(carlos, true);
    store.createProject(ana, 'kiosk');
    assert.equal(store.scope.status(ana, 'kiosk').state, 'scoping');
    const { ticket } = store.tickets.create(ana, 'kiosk', { title: 'Build the kiosk API' });
    const refused = code(() => store.tickets.update(bot, ticket.ref, { status: 'In Progress' }));
    assert.match(refused, /^conflict: Scope not approved: scoping\/SCOPE.md still needs Why this exists; What already exists/);
    assert.match(code(() => store.tickets.start(bot, ticket.ref)), /Scope not approved/);
    // The scoping work itself moves.
    store.tickets.createLabel(ana, 'kiosk', 'scope');
    const scoping = store.tickets.create(ana, 'kiosk', { title: 'Write the scope', labels: ['scope'] }).ticket;
    assert.equal(store.tickets.update(bot, scoping.ref, { status: 'In Progress' }).ticket.status.name, 'In Progress');
    // Repos, stacks and deploys are refused while in Scope.
    assert.match(code(() => store.approvals.request(bot, { room: 'kiosk/general', summary: 'Create the kiosk-api repo on Gitea' })), /No repos, stacks or deploys/);
    store.scope.start(ana, 'kiosk');
    store.files.write(bot, 'kiosk', 'scoping/SCOPE.md', filled('kiosk', ['What it owes other projects']), { baseVersion: 1 });
    assert.deepEqual(store.scope.status(ana, 'kiosk').missing, ['What it owes other projects']);
    assert.match(code(() => store.scope.approve(ana, 'kiosk')), /nothing under: What it owes other projects/);
    store.files.write(bot, 'kiosk', 'scoping/SCOPE.md', filled('kiosk'), { baseVersion: 2 });
    const ben = store.createUser('ben').participant;
    store.addMember(ana, 'kiosk', 'ben');
    assert.match(code(() => store.scope.approve(ben, 'kiosk')), /^forbidden: Only admins of kiosk/);
    const approved = store.scope.approve(ana, 'kiosk');
    assert.equal(approved.state, 'approved');
    assert.equal(approved.approvedVersion, 3);
    assert.match(store.decisions.get(ana, approved.decisionId!).title, /Scope of kiosk approved \(scoping\/SCOPE.md v3\)/);
    assert.equal(store.tickets.update(bot, ticket.ref, { status: 'In Progress' }).ticket.status.name, 'In Progress');
    // Changing an approved scope needs approval again.
    store.files.write(bot, 'kiosk', 'scoping/SCOPE.md', `${filled('kiosk')}\nOne more thing.`, { baseVersion: 3 });
    assert.equal(store.scope.status(ana, 'kiosk').state, 'scoping');
  });

  it('reads headings with or without numbers and ignores comment hints', () => {
    assert.deepEqual(missingSections('## Why this exists\n<!-- hint -->\n> Covers: a hint\n\n## 2. What already exists (do not rebuild)\nThe old app.', ['Why this exists', 'What already exists (do not rebuild)']), ['Why this exists']);
  });
});
