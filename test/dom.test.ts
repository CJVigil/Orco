import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { children, guardDom, replace } from '../web/dom.js';

// A stand-in for an element that stringifies what it is given, as the DOM does with null.
class FakeElement {
  kids: string[] = [];
  replaceChildren(...nodes: unknown[]) {
    this.kids = nodes.map(String);
  }
  append(...nodes: unknown[]) {
    this.kids.push(...nodes.map(String));
  }
  prepend(...nodes: unknown[]) {
    this.kids.unshift(...nodes.map(String));
  }
}

describe('no literal "null" in the page (#147)', () => {
  it('children() drops null, undefined and false, and flattens', () => {
    assert.deepEqual(children(['a', null, ['b', undefined, [false, 'c']]]), ['a', 'b', 'c']);
  });

  it('replace() never hands null to replaceChildren', () => {
    const box = new FakeElement();
    // The room ticker with one live task, and the Inbox with nothing in Needs you and no tasks.
    replace(box as never, 'line', null);
    assert.deepEqual(box.kids, ['line']);
    replace(box as never, null, 'Mentions', 'mention', undefined);
    assert.deepEqual(box.kids, ['Mentions', 'mention']);
  });

  it('guardDom() makes replaceChildren, append and prepend skip empty values everywhere', () => {
    const proto = FakeElement.prototype;
    const before = new FakeElement();
    before.replaceChildren('a', null);
    assert.deepEqual(before.kids, ['a', 'null'], 'unguarded, null becomes text');
    guardDom(proto as never);
    guardDom(proto as never); // twice is harmless
    const box = new FakeElement();
    box.replaceChildren('a', null, undefined, 'b');
    box.append(null, 'c');
    box.prepend(undefined, 'z');
    assert.deepEqual(box.kids, ['z', 'a', 'b', 'c']);
  });
});
