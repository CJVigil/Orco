import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { appLink, messageLink, taskLink, ticketLink, withUrl } from '../src/links.js';

describe('links into the app (#129)', () => {
  it('builds ticket, message and task links from ORCO_PUBLIC_URL', () => {
    assert.equal(ticketLink('shop', 'SHO-12', 'https://orco.example.com/'), 'https://orco.example.com/#~shop/SHO-12');
    assert.equal(messageLink(42, 'https://example.com/orco'), 'https://example.com/orco/#!m/42');
    assert.equal(taskLink(7, 'https://orco.example.com'), 'https://orco.example.com/#!t/7');
  });
  it('leaves the link out when unset or local', () => {
    assert.equal(appLink('!m/1', ''), undefined);
    assert.equal(appLink('!m/1', 'http://localhost:7420'), undefined);
    assert.equal(appLink('!m/1', 'http://127.0.0.1:7420'), undefined);
    assert.equal(appLink('!m/1', 'not a url'), undefined);
    assert.deepEqual(withUrl(undefined), {});
  });
});
