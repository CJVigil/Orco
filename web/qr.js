/*
 * A small QR code encoder (#137): byte mode, error correction level M, versions 1-15, the eight
 * masks scored as the standard says. No dependencies and no network: it turns a sign-in link into
 * a grid of dark and light modules that the browser draws as SVG-free DOM and the CLI prints as text.
 * Written from the QR specification (ISO/IEC 18004); the layout follows the usual reference order.
 */

// Per version (1-15), level M: [total codewords, ec codewords per block, blocks in group 1, data cw per
// block in group 1, blocks in group 2, data cw per block in group 2].
const TABLE_M = [
  null,
  [26, 10, 1, 16, 0, 0],
  [44, 16, 1, 28, 0, 0],
  [70, 26, 1, 44, 0, 0],
  [100, 18, 2, 32, 0, 0],
  [134, 24, 2, 43, 0, 0],
  [172, 16, 4, 27, 0, 0],
  [196, 18, 4, 31, 0, 0],
  [242, 22, 2, 38, 2, 39],
  [292, 22, 3, 36, 2, 37],
  [346, 26, 4, 43, 1, 44],
  [404, 30, 1, 50, 4, 51],
  [466, 22, 6, 36, 2, 37],
  [532, 22, 8, 37, 1, 38],
  [581, 22, 4, 40, 5, 41],
  [655, 24, 5, 41, 5, 42],
];

const ALIGN = [null, [], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34], [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 50], [6, 30, 54], [6, 32, 58], [6, 34, 62], [6, 26, 46, 66], [6, 26, 48, 70]];

// Galois field 256 for Reed-Solomon.
const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
for (let i = 0, x = 1; i < 255; i++) {
  EXP[i] = x;
  LOG[x] = i;
  x <<= 1;
  if (x & 0x100) x ^= 0x11d;
}
for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
const mul = (a, b) => (a && b ? EXP[LOG[a] + LOG[b]] : 0);

function rsGenerator(degree) {
  let poly = [1];
  for (let i = 0; i < degree; i++) {
    const next = new Array(poly.length + 1).fill(0);
    for (let j = 0; j < poly.length; j++) {
      next[j] ^= poly[j];
      next[j + 1] ^= mul(poly[j], EXP[i]);
    }
    poly = next;
  }
  return poly;
}

function rsRemainder(data, degree) {
  const gen = rsGenerator(degree);
  const out = new Array(degree).fill(0);
  for (const byte of data) {
    const factor = byte ^ out.shift();
    out.push(0);
    for (let i = 0; i < degree; i++) out[i] ^= mul(gen[i + 1], factor);
  }
  return out;
}

function capacity(version) {
  const [, , b1, d1, b2, d2] = TABLE_M[version];
  return b1 * d1 + b2 * d2;
}

/** The codewords for the text, data then error correction, interleaved. */
function codewords(bytes, version) {
  const cap = capacity(version);
  const bits = [];
  const put = (value, length) => {
    for (let i = length - 1; i >= 0; i--) bits.push((value >>> i) & 1);
  };
  put(0b0100, 4);
  put(bytes.length, version < 10 ? 8 : 16);
  for (const b of bytes) put(b, 8);
  put(0, Math.min(4, cap * 8 - bits.length));
  while (bits.length % 8) bits.push(0);
  const data = [];
  for (let i = 0; i < bits.length; i += 8) data.push(bits.slice(i, i + 8).reduce((a, b) => (a << 1) | b, 0));
  for (let pad = 0xec; data.length < cap; pad ^= 0xec ^ 0x11) data.push(pad);
  const [, ec, b1, d1, b2, d2] = TABLE_M[version];
  const blocks = [];
  let at = 0;
  for (let i = 0; i < b1 + b2; i++) {
    const size = i < b1 ? d1 : d2;
    const block = data.slice(at, at + size);
    at += size;
    blocks.push({ data: block, ec: rsRemainder(block, ec) });
  }
  const out = [];
  for (let i = 0; i < Math.max(d1, d2); i++) for (const b of blocks) if (i < b.data.length) out.push(b.data[i]);
  for (let i = 0; i < ec; i++) for (const b of blocks) out.push(b.ec[i]);
  return out;
}

function formatBits(mask) {
  // Level M is 00.
  const data = (0b00 << 3) | mask;
  let rem = data;
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
  return ((data << 10) | (rem & 0x3ff)) ^ 0x5412;
}

function versionBits(version) {
  let rem = version;
  for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
  return (version << 12) | (rem & 0xfff);
}

const MASKS = [
  (r, c) => (r + c) % 2 === 0,
  (r) => r % 2 === 0,
  (_r, c) => c % 3 === 0,
  (r, c) => (r + c) % 3 === 0,
  (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
  (r, c) => ((r * c) % 2) + ((r * c) % 3) === 0,
  (r, c) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0,
  (r, c) => (((r + c) % 2) + ((r * c) % 3)) % 2 === 0,
];

function build(version, words, mask) {
  const n = version * 4 + 17;
  const grid = Array.from({ length: n }, () => new Array(n).fill(false));
  const fixed = Array.from({ length: n }, () => new Array(n).fill(false));
  const set = (r, c, dark) => {
    grid[r][c] = dark;
    fixed[r][c] = true;
  };
  const finder = (r, c) => {
    for (let dr = -1; dr <= 7; dr++)
      for (let dc = -1; dc <= 7; dc++) {
        const rr = r + dr;
        const cc = c + dc;
        if (rr < 0 || cc < 0 || rr >= n || cc >= n) continue;
        const ring = Math.max(Math.abs(dr - 3), Math.abs(dc - 3));
        set(rr, cc, ring !== 2 && ring !== 4);
      }
  };
  finder(0, 0);
  finder(0, n - 7);
  finder(n - 7, 0);
  for (let i = 8; i < n - 8; i++) {
    set(6, i, i % 2 === 0);
    set(i, 6, i % 2 === 0);
  }
  const al = ALIGN[version];
  for (const r of al)
    for (const c of al) {
      if ((r === 6 && c === 6) || (r === 6 && c === n - 7) || (r === n - 7 && c === 6)) continue;
      for (let dr = -2; dr <= 2; dr++) for (let dc = -2; dc <= 2; dc++) set(r + dr, c + dc, Math.max(Math.abs(dr), Math.abs(dc)) !== 1);
    }
  // Format and version areas, reserved now and written below.
  const fmt = formatBits(mask);
  const bit = (i) => ((fmt >>> i) & 1) === 1;
  // First copy around the top-left finder: down column 8, then along row 8.
  for (let i = 0; i <= 5; i++) set(i, 8, bit(i));
  set(7, 8, bit(6));
  set(8, 8, bit(7));
  set(8, 7, bit(8));
  for (let i = 9; i < 15; i++) set(8, 14 - i, bit(i));
  // Second copy: along row 8 at the right, and down column 8 at the bottom, with the dark module.
  for (let i = 0; i < 8; i++) set(8, n - 1 - i, bit(i));
  for (let i = 8; i < 15; i++) set(n - 15 + i, 8, bit(i));
  set(n - 8, 8, true);
  if (version >= 7) {
    const v = versionBits(version);
    for (let i = 0; i < 18; i++) {
      const bit = ((v >>> i) & 1) === 1;
      const a = Math.floor(i / 3);
      const b = n - 11 + (i % 3);
      set(a, b, bit);
      set(b, a, bit);
    }
  }
  // Data, in the zigzag, masked.
  const bits = [];
  for (const w of words) for (let i = 7; i >= 0; i--) bits.push((w >>> i) & 1);
  let k = 0;
  for (let right = n - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < n; vert++) {
      for (let j = 0; j < 2; j++) {
        const c = right - j;
        const upward = ((right + 1) & 2) === 0;
        const r = upward ? n - 1 - vert : vert;
        if (fixed[r][c]) continue;
        let dark = k < bits.length ? bits[k] === 1 : false;
        k++;
        if (MASKS[mask](r, c)) dark = !dark;
        grid[r][c] = dark;
      }
    }
  }
  return grid;
}

function penalty(grid) {
  const n = grid.length;
  let score = 0;
  const lines = (get) => {
    for (let a = 0; a < n; a++) {
      let run = 1;
      for (let b = 1; b < n; b++) {
        if (get(a, b) === get(a, b - 1)) {
          run++;
          if (run === 5) score += 3;
          else if (run > 5) score++;
        } else run = 1;
      }
      for (let b = 0; b + 10 < n + 1; b++) {
        const seq = [];
        for (let i = 0; i < 11 && b + i < n; i++) seq.push(get(a, b + i) ? 1 : 0);
        const s = seq.join('');
        if (s === '10111010000' || s === '00001011101') score += 40;
      }
    }
  };
  lines((a, b) => grid[a][b]);
  lines((a, b) => grid[b][a]);
  for (let r = 0; r + 1 < n; r++)
    for (let c = 0; c + 1 < n; c++) {
      const v = grid[r][c];
      if (v === grid[r][c + 1] && v === grid[r + 1][c] && v === grid[r + 1][c + 1]) score += 3;
    }
  let dark = 0;
  for (const row of grid) for (const v of row) if (v) dark++;
  score += Math.floor(Math.abs((dark * 100) / (n * n) - 50) / 5) * 10;
  return score;
}

/** The QR code for a text: a square grid of booleans (true is dark), without the quiet zone. */
export function qrMatrix(text) {
  const bytes = [...new TextEncoder().encode(text)];
  let version = 1;
  while (version <= 15 && capacity(version) < bytes.length + (version < 10 ? 2 : 3)) version++;
  if (version > 15) throw new Error('Too long for a QR code here');
  const words = codewords(bytes, version);
  let best = null;
  for (let mask = 0; mask < 8; mask++) {
    const grid = build(version, words, mask);
    const score = penalty(grid);
    if (!best || score < best.score) best = { grid, score };
  }
  return best.grid;
}

/** The code as text for a terminal: two modules per character, with a quiet zone. */
export function qrText(text) {
  const grid = qrMatrix(text);
  const n = grid.length;
  const at = (r, c) => r >= 0 && c >= 0 && r < n && c < n && grid[r][c];
  const lines = [];
  for (let r = -2; r < n + 2; r += 2) {
    let line = '';
    for (let c = -2; c < n + 2; c++) {
      const top = at(r, c);
      const bottom = at(r + 1, c);
      // Light modules are drawn as ink on a dark terminal: invert so dark modules stay dark.
      line += top && bottom ? ' ' : top ? '▄' : bottom ? '▀' : '█';
    }
    lines.push(line);
  }
  return lines.join('\n');
}

/** The code as a canvas-free element: a CSS grid of cells, built with the DOM only. */
export function qrElement(text, size = 240) {
  const grid = qrMatrix(text);
  const n = grid.length + 8;
  const box = document.createElement('div');
  box.className = 'qr';
  box.setAttribute('role', 'img');
  box.setAttribute('aria-label', 'QR code');
  box.style.cssText = `display:grid;grid-template-columns:repeat(${n},1fr);width:${size}px;height:${size}px;background:#fff;`;
  for (let r = -4; r < n - 4; r++)
    for (let c = -4; c < n - 4; c++) {
      const cell = document.createElement('span');
      if (r >= 0 && c >= 0 && r < grid.length && c < grid.length && grid[r][c]) cell.style.background = '#000';
      box.append(cell);
    }
  return box;
}
