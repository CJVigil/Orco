import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { commandSuggestions, parseCommand } from '../web/commands.js';

describe('slash commands (#93)', () => {
  it('reads each command and its arguments, quotes or not', () => {
    assert.deepEqual(parseCommand('/next "call Michael"'), { name: 'next', text: 'call Michael' });
    assert.deepEqual(parseCommand('/next call Michael'), { name: 'next', text: 'call Michael' });
    assert.deepEqual(parseCommand('/ticket “Kiosk printer jams”'), { name: 'ticket', title: 'Kiosk printer jams' });
    assert.deepEqual(parseCommand('/assign @carlos-claude'), { name: 'assign', who: 'carlos-claude' });
    assert.deepEqual(parseCommand('/assign none'), { name: 'assign', who: null });
    assert.deepEqual(parseCommand('/waiting @ana "open port 443"'), { name: 'waiting', who: 'ana', ask: 'open port 443' });
    assert.deepEqual(parseCommand('/done'), { name: 'done' });
    assert.deepEqual(parseCommand('/search refund flow'), { name: 'search', query: 'refund flow' });
    assert.deepEqual(parseCommand('/task @bot fix it'), { name: 'task', text: '/task @bot fix it' });
  });

  it('says how to use a command typed wrong, and leaves ordinary text alone', () => {
    assert.deepEqual(parseCommand('/next'), { name: 'next', error: 'Use /next "the next step"' });
    assert.deepEqual(parseCommand('/waiting @ana'), { name: 'waiting', error: 'Use /waiting @person "what you need"' });
    assert.deepEqual(parseCommand('/done now'), { name: 'done', error: 'Use /done' });
    assert.equal(parseCommand('/tmp is full again'), null, 'a path is not a command');
    assert.equal(parseCommand('/shrug'), null);
    assert.equal(parseCommand('next "x"'), null);
  });

  it('suggests the commands that fit where you type', () => {
    assert.deepEqual(commandSuggestions('/', 'ticket').map((c) => c.name), ['ticket', 'assign', 'next', 'waiting', 'done', 'search']);
    assert.deepEqual(commandSuggestions('/n', 'room').map((c) => c.name), ['next']);
    assert.ok(commandSuggestions('/', 'room').some((c) => c.name === 'task'));
    assert.ok(!commandSuggestions('/', 'ticket').some((c) => c.name === 'task'), 'a ticket box gives no tasks');
  });
});
