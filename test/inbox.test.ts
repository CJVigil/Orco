import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { openDatabase } from '../src/db.js';
import { OrcoError, type Participant, Store } from '../src/store.js';

let store: Store;
let ana: Participant;
let ben: Participant;
let cara: Participant;
let anaClaude: Participant;
let benCodex: Participant;

beforeEach(() => {
  store = new Store(openDatabase(':memory:'));
  ana = store.createUser('ana').participant;
  ben = store.createUser('ben').participant;
  cara = store.createUser('cara').participant;
  anaClaude = store.createAgent('ana', 'ana-claude').participant;
  benCodex = store.createAgent('ben', 'ben-codex').participant;
  store.createProject(ana, 'api');
  store.addMember(ana, 'api', 'ben');
});

describe('mention history', () => {
  it('lists recent mentions newest first, with what has been seen', () => {
    const first = store.post(ben, 'api/general', '@ana first');
    store.post(benCodex, 'api/general', '@ana second');
    store.markMentionsSeen(ana, first.id);
    const mentions = store.recentMentions(ana);
    assert.deepEqual(
      mentions.map((m) => [m.text, m.seen]),
      [
        ['@ana second', false],
        ['@ana first', true],
      ],
    );
  });

  it('drops mentions from rooms the person can no longer see', () => {
    store.createProject(cara, 'secret');
    store.addMember(cara, 'secret', 'ana');
    store.post(cara, 'secret/general', '@ana private');
    assert.equal(store.recentMentions(ana).length, 1);
    assert.equal(store.recentMentions(ben).length, 0);
  });
});

describe('tasks for my agents', () => {
  it('lists open tasks assigned to any of my agents', () => {
    store.setTaskPolicy(ana, 'ana-claude', 'open');
    store.tasks.create(ben, { agent: 'ana-claude', room: 'api/general', request: 'review the PR' });
    const done = store.tasks.create(ana, { agent: 'ana-claude', room: 'api/general', request: 'old' });
    store.tasks.update(anaClaude, done.id, 'done');
    assert.deepEqual(
      store.tasks.list(ana, { forMyAgents: true, open: true }).map((t) => t.request),
      ['review the PR'],
    );
    assert.deepEqual(store.tasks.list(ben, { forMyAgents: true, open: true }), []);
  });
});

describe('search', () => {
  it('finds messages only in rooms you can see', () => {
    store.post(ana, 'api/general', 'Deploy failed on step 3');
    store.post(ben, 'lobby', 'deploy window is Friday');
    store.createProject(cara, 'secret');
    store.post(cara, 'secret/general', 'deploy keys rotated');
    assert.deepEqual(
      store.search(ben, 'DEPLOY').map((m) => m.text),
      ['deploy window is Friday', 'Deploy failed on step 3'],
    );
    assert.deepEqual(
      store.search(cara, 'deploy').map((m) => m.text),
      ['deploy keys rotated', 'deploy window is Friday'],
    );
  });

  it('treats % and _ literally', () => {
    store.post(ana, 'lobby', 'up 50% today');
    store.post(ana, 'lobby', 'up 50 points');
    store.post(ana, 'lobby', 'call get_task');
    store.post(ana, 'lobby', 'call getXtask');
    assert.deepEqual(
      store.search(ana, '50%').map((m) => m.text),
      ['up 50% today'],
    );
    assert.deepEqual(
      store.search(ana, 'get_task').map((m) => m.text),
      ['call get_task'],
    );
  });

  it('refuses searches that are too short', () => {
    assert.throws(() => store.search(ana, 'a'), OrcoError);
  });
});

describe('agent activity', () => {
  it('shows what each agent is working on, to people who can see the room', () => {
    store.setTaskPolicy(ana, 'ana-claude', 'open');
    const task = store.tasks.create(ben, { agent: 'ana-claude', room: 'api/general', request: 'review the PR' });
    assert.equal(store.tasks.activity(ana).size, 0);
    store.tasks.update(anaClaude, task.id, 'accepted');
    const working = store.tasks.activity(ben).get(anaClaude.id);
    assert.equal(working?.taskId, task.id);
    assert.equal(working?.messageId, task.messageId);
    assert.equal(working?.room, 'api/general');
    assert.equal(store.tasks.activity(cara).size, 0);
    store.tasks.update(anaClaude, task.id, 'done');
    assert.equal(store.tasks.activity(ana).size, 0);
  });
});
