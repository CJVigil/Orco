import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { fitSize, jpegName, MAX_SIDE } from '../web/photos.js';

describe('photo shrinking (#127)', () => {
  it('fits the long side to 2,400 px and keeps the shape', () => {
    assert.deepEqual(fitSize(4032, 3024), { width: MAX_SIDE, height: 1800 });
    assert.deepEqual(fitSize(3024, 4032), { width: 1800, height: MAX_SIDE });
    assert.deepEqual(fitSize(1200, 900), { width: 1200, height: 900 });
  });
  it('names the result .jpg', () => {
    assert.equal(jpegName('IMG_2041.HEIC'), 'IMG_2041.jpg');
    assert.equal(jpegName('scan.png'), 'scan.jpg');
    assert.equal(jpegName(''), 'photo.jpg');
  });
});
