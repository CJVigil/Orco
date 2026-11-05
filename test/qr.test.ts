import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { localOnly, phoneHints } from '../src/lan.js';
import { qrMatrix, qrText } from '../web/qr.js';

describe('QR codes for phones (#137)', () => {
  it('sizes the code to the text and draws the three finder patterns', () => {
    const small = qrMatrix('hi');
    assert.equal(small.length, 21);
    const link = qrMatrix('http://192.168.1.20:7420/#signin=abcDEF123_-xyz0123456789');
    assert.ok(link.length > 21 && (link.length - 17) % 4 === 0);
    for (const [r, c] of [[0, 0], [0, link.length - 7], [link.length - 7, 0]] as [number, number][]) {
      const row = link[r]!.slice(c, c + 7);
      assert.deepEqual(row, [true, true, true, true, true, true, true]);
      assert.deepEqual([link[r + 2]![c], link[r + 2]![c + 1], link[r + 2]![c + 2]], [true, false, true]);
    }
    assert.throws(() => qrMatrix('x'.repeat(900)));
    assert.ok(qrText('hi').split('\n').length > 10);
  });

  it('never sends phones to localhost, and says how to reach the server', () => {
    assert.equal(localOnly('127.0.0.1'), true);
    assert.equal(localOnly('0.0.0.0'), false);
    assert.match(phoneHints('127.0.0.1', 7420).join('\n'), /ORCO_HOST=0\.0\.0\.0/);
    const hints = phoneHints('0.0.0.0', 7420, 'win32').join('\n');
    assert.ok(!/127\.0\.0\.1|localhost/.test(hints));
  });
});
