import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createOutbox, retryable } from '../web/drafts.js';

describe('outbox (#130)', () => {
  it('retries only failures that may not have reached the server', () => {
    assert.equal(retryable(new TypeError('Failed to fetch')), true);
    assert.equal(retryable(Object.assign(new Error('Bad gateway'), { status: 502 })), true);
    assert.equal(retryable(Object.assign(new Error('Forbidden'), { status: 403 })), false);
  });

  it('keeps a message until it gets through, then sends it once', async () => {
    let online = false;
    const sent: string[] = [];
    const dropped: string[] = [];
    const box = createOutbox(() => 'ana', {
      send: async (item: { key: string }) => {
        if (!online) throw new TypeError('offline');
        sent.push(item.key);
        return { id: 1 };
      },
      onDropped: (item: { key: string }) => dropped.push(item.key),
    });
    box.add({ key: 'a', place: 'shop/general', room: 'shop/general', body: {}, text: 'hi' });
    await box.flush();
    assert.equal(box.items().length, 1);
    online = true;
    await box.flush();
    await box.flush();
    assert.deepEqual(sent, ['a']);
    assert.equal(box.items().length, 0);
    assert.deepEqual(dropped, []);
  });
});
