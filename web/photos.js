/*
 * Photos (#127): big phone pictures shrink before upload instead of failing, and images open in an
 * in-app viewer with pinch-zoom, pan and swipe.
 *
 * prepareImage scales an image whose long side is over MAX_SIDE, or whose file is over the server's
 * cap, to a JPEG in a canvas. It always re-encodes JPEG and HEIC, which drops EXIF data such as
 * where the photo was taken. HEIC is converted where the browser can decode it and refused with a
 * clear message where it cannot. GIFs are left alone (re-encoding would stop them moving).
 */
export const MAX_SIDE = 2400;
export const MAX_BYTES = 5 * 1024 * 1024;
const QUALITY = 0.85;

const isHeic = (file) => /image\/hei[cf]/i.test(file.type) || /\.hei[cf]$/i.test(file.name || '');

/** The output name: the original with a .jpg ending. */
export function jpegName(name) {
  const base = (name || 'photo').replace(/\.[a-z0-9]{1,5}$/i, '');
  return `${base || 'photo'}.jpg`;
}

/** The size to draw at so the long side is at most max. */
export function fitSize(width, height, max = MAX_SIDE) {
  const long = Math.max(width, height);
  if (long <= max) return { width, height };
  const k = max / long;
  return { width: Math.round(width * k), height: Math.round(height * k) };
}

async function decode(file) {
  try {
    return await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch {
    return null;
  }
}

function toBlob(canvas, quality) {
  return new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', quality));
}

/** Returns a File ready to upload, or throws an Error whose message says what to do. */
export async function prepareImage(file) {
  const heic = isHeic(file);
  if (file.type === 'image/gif') {
    if (file.size > MAX_BYTES) throw new Error(`${file.name || 'That GIF'} is over 5 MB; GIFs are not shrunk, so they keep moving`);
    return file;
  }
  const jpeg = file.type === 'image/jpeg';
  const bitmap = await decode(file);
  if (!bitmap) {
    if (heic) throw new Error(`${file.name || 'That photo'} is HEIC, which this browser cannot open. Share it as JPEG (on iPhone: Settings > Camera > Formats > Most Compatible), or attach it from another browser.`);
    if (file.size > MAX_BYTES) throw new Error(`${file.name || 'That image'} is over 5 MB and this browser cannot shrink it`);
    return file;
  }
  const big = Math.max(bitmap.width, bitmap.height) > MAX_SIDE || file.size > MAX_BYTES;
  if (!big && !jpeg && !heic) {
    bitmap.close?.();
    return file;
  }
  let { width, height } = fitSize(bitmap.width, bitmap.height);
  let quality = QUALITY;
  for (let attempt = 0; attempt < 6; attempt++) {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const g = canvas.getContext('2d');
    // JPEG has no transparency; a white ground keeps transparent PNGs readable.
    g.fillStyle = '#fff';
    g.fillRect(0, 0, width, height);
    g.drawImage(bitmap, 0, 0, width, height);
    const blob = await toBlob(canvas, quality);
    if (blob && blob.size <= MAX_BYTES) {
      bitmap.close?.();
      return new File([blob], jpegName(file.name), { type: 'image/jpeg', lastModified: Date.now() });
    }
    if (quality > 0.6) quality -= 0.1;
    else ({ width, height } = { width: Math.round(width * 0.8), height: Math.round(height * 0.8) });
  }
  bitmap.close?.();
  throw new Error(`${file.name || 'That image'} could not be made smaller than 5 MB`);
}

/* The viewer: one overlay for the whole app. */
let overlay = null;

/**
 * Opens images full screen: pinch or wheel to zoom, drag to pan, double-tap to zoom in or out, swipe
 * or arrow keys between images, Esc or Back to close.
 */
export function openLightbox(el, icon, images, start = 0) {
  overlay?.close();
  let index = start;
  let scale = 1;
  let x = 0;
  let y = 0;
  const img = el('img', { class: 'lightbox-image', alt: '', draggable: false });
  const counter = el('span', { class: 'lightbox-count' });
  const download = el('a', { class: 'lightbox-button', title: 'Download', 'aria-label': 'Download' }, icon('download'));
  const close = el('button', { class: 'lightbox-button', type: 'button', title: 'Close (Esc)', 'aria-label': 'Close' }, icon('x'));
  const prev = el('button', { class: 'lightbox-nav prev', type: 'button', 'aria-label': 'Previous image' }, '‹');
  const next = el('button', { class: 'lightbox-nav next', type: 'button', 'aria-label': 'Next image' }, '›');
  const stage = el('div', { class: 'lightbox-stage' }, img);
  const box = el('div', { class: 'lightbox', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Image viewer', tabindex: '-1' }, stage, el('div', { class: 'lightbox-bar' }, counter, el('span', { class: 'spacer' }), download, close), prev, next);

  const apply = () => {
    img.style.transform = `translate(${x}px, ${y}px) scale(${scale})`;
    box.classList.toggle('zoomed', scale > 1);
  };
  const reset = () => {
    scale = 1;
    x = 0;
    y = 0;
    apply();
  };
  const clampPan = () => {
    const r = stage.getBoundingClientRect();
    const maxX = Math.max(0, (img.offsetWidth * scale - r.width) / 2);
    const maxY = Math.max(0, (img.offsetHeight * scale - r.height) / 2);
    x = Math.min(maxX, Math.max(-maxX, x));
    y = Math.min(maxY, Math.max(-maxY, y));
  };
  const zoomAt = (factor, cx, cy) => {
    const r = stage.getBoundingClientRect();
    const next = Math.min(6, Math.max(1, scale * factor));
    const k = next / scale;
    // Keep the point under the fingers (or cursor) where it is.
    const px = cx - (r.left + r.width / 2);
    const py = cy - (r.top + r.height / 2);
    x = px - (px - x) * k;
    y = py - (py - y) * k;
    scale = next;
    if (scale === 1) x = y = 0;
    clampPan();
    apply();
  };
  const show = (i) => {
    index = (i + images.length) % images.length;
    const image = images[index];
    img.src = image.url;
    img.alt = image.name || 'image';
    download.href = image.url;
    download.download = image.name || 'image';
    counter.textContent = images.length > 1 ? `${index + 1} / ${images.length}` : image.name || '';
    prev.hidden = next.hidden = images.length < 2;
    reset();
  };

  // Pointers: one finger pans (or swipes when not zoomed), two pinch.
  const pointers = new Map();
  let pinch = null;
  let swipe = null;
  let lastTap = 0;
  stage.addEventListener('pointerdown', (event) => {
    stage.setPointerCapture(event.pointerId);
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      pinch = { d: Math.hypot(a.x - b.x, a.y - b.y), scale };
      swipe = null;
    } else {
      swipe = { x: event.clientX, y: event.clientY, panX: x, panY: y, t: Date.now() };
    }
  });
  stage.addEventListener('pointermove', (event) => {
    if (!pointers.has(event.pointerId)) return;
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (pinch && pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      zoomAt((pinch.scale * d) / pinch.d / scale, (a.x + b.x) / 2, (a.y + b.y) / 2);
    } else if (swipe && scale > 1) {
      x = swipe.panX + event.clientX - swipe.x;
      y = swipe.panY + event.clientY - swipe.y;
      clampPan();
      apply();
    }
  });
  const up = (event) => {
    if (!pointers.has(event.pointerId)) return;
    pointers.delete(event.pointerId);
    if (pointers.size < 2) pinch = null;
    if (swipe && pointers.size === 0) {
      const dx = event.clientX - swipe.x;
      const dy = event.clientY - swipe.y;
      const quick = Date.now() - swipe.t < 300 && Math.hypot(dx, dy) < 10;
      if (scale === 1 && Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.5 && images.length > 1) show(index + (dx < 0 ? 1 : -1));
      else if (scale === 1 && dy > 120 && Math.abs(dy) > Math.abs(dx) * 1.5) finish();
      else if (quick) {
        if (Date.now() - lastTap < 300) {
          if (scale > 1) reset();
          else zoomAt(2.5, event.clientX, event.clientY);
          lastTap = 0;
        } else lastTap = Date.now();
      }
      swipe = null;
    }
  };
  stage.addEventListener('pointerup', up);
  stage.addEventListener('pointercancel', up);
  stage.addEventListener(
    'wheel',
    (event) => {
      event.preventDefault();
      zoomAt(event.deltaY < 0 ? 1.15 : 1 / 1.15, event.clientX, event.clientY);
    },
    { passive: false },
  );

  const onKey = (event) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      finish();
    } else if (event.key === 'ArrowRight') show(index + 1);
    else if (event.key === 'ArrowLeft') show(index - 1);
    else if (event.key === '+' || event.key === '=') zoomAt(1.4, innerWidth / 2, innerHeight / 2);
    else if (event.key === '-') zoomAt(1 / 1.4, innerWidth / 2, innerHeight / 2);
  };
  // Back closes the viewer instead of leaving the page.
  const onPop = () => finish(true);
  let closed = false;
  const finish = (fromHistory = false) => {
    if (closed) return;
    closed = true;
    document.removeEventListener('keydown', onKey, true);
    removeEventListener('popstate', onPop);
    box.remove();
    document.body.classList.remove('lightbox-open');
    overlay = null;
    if (!fromHistory && history.state?.lightbox) history.back();
  };
  close.addEventListener('click', () => finish());
  prev.addEventListener('click', () => show(index - 1));
  next.addEventListener('click', () => show(index + 1));
  box.addEventListener('click', (event) => {
    if (event.target === box) finish();
  });

  document.addEventListener('keydown', onKey, true);
  history.pushState({ ...(history.state || {}), lightbox: true }, '');
  addEventListener('popstate', onPop);
  document.body.append(box);
  document.body.classList.add('lightbox-open');
  show(start);
  box.focus();
  overlay = { close: () => finish() };
  return overlay;
}
