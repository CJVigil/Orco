// Desktop and phone notifications for things that need a person: mentions (which include questions,
// approvals and @all) and flags from your agents. Shown only while Orco is open, possibly in a
// background tab or as an installed app; there is no push from the server.

const KEY = 'orco-notify';

export function supported() {
  return 'Notification' in window;
}

export function enabled() {
  try {
    return supported() && Notification.permission === 'granted' && localStorage.getItem(KEY) === 'on';
  } catch {
    return false;
  }
}

/** Turns notifications on (asking for permission if needed) or off. Returns the new state. */
export async function toggle() {
  if (!supported()) throw new Error('This browser cannot show notifications. On iPhone, add Orco to the Home Screen first.');
  const on = !enabled();
  if (on && Notification.permission !== 'granted') {
    const answer = await Notification.requestPermission();
    if (answer !== 'granted') throw new Error('Notifications are blocked for this site; allow them in the browser settings.');
  }
  try {
    localStorage.setItem(KEY, on ? 'on' : 'off');
  } catch {
    // Without storage the choice lasts until the page reloads.
  }
  return enabled();
}

let registration = null;

export async function registerWorker(onOpen) {
  if (!('serviceWorker' in navigator)) return;
  try {
    registration = await navigator.serviceWorker.register('/sw.js');
    navigator.serviceWorker.addEventListener('message', (event) => {
      if (event.data?.type === 'open') onOpen(event.data);
    });
  } catch {
    // Service workers need HTTPS or localhost; plain notifications still work where allowed.
  }
}

/** Shows a notification unless the person is already looking at Orco. */
export async function show({ title, body, tag, hash, target = null }, onOpen) {
  if (!enabled() || (document.visibilityState === 'visible' && document.hasFocus())) return;
  const options = { body: body.length > 180 ? `${body.slice(0, 177)}…` : body, tag, data: { hash, target }, icon: '/icon-192.png', badge: '/icon-192.png' };
  try {
    // Phones only show notifications through a service worker.
    if (registration) await registration.showNotification(title, options);
    else new Notification(title, options).onclick = () => {
      window.focus();
      onOpen({ hash, target });
    };
  } catch {
    // A notification that cannot be shown is not worth an error.
  }
}

/** The Inbox count on the installed app's icon, where the platform supports it. */
export function setBadge(count) {
  try {
    if (count > 0) navigator.setAppBadge?.(count);
    else navigator.clearAppBadge?.();
  } catch {
    // Not supported here.
  }
}

/*
 * Calmer notifications (#89). What needs the person (approvals, questions, reviews, asks waiting on
 * them) shows at once; updates from agents batch into one notification per 10 minutes; people's plain
 * mentions show only on "All mentions". In quiet hours everything waits and arrives as one summary.
 * The settings live on the server (they follow the person); this applies them in the browser.
 */
const BATCH_MS = 10 * 60_000;
let settings = { notifyLevel: 'needs_me', quietStart: null, quietEnd: null, tz: 'UTC' };
let batch = [];
let batchTimer = null;
let held = [];
let onOpenHeld = () => {};

export function configure(next, onOpen) {
  if (next) settings = { ...settings, ...next };
  if (onOpen) onOpenHeld = onOpen;
}

function localTime(tz) {
  try {
    return new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date());
  } catch {
    return new Date().toTimeString().slice(0, 5);
  }
}

export function inQuietHours() {
  const { quietStart: start, quietEnd: end, tz } = settings;
  if (!start || !end) return false;
  const now = localTime(tz);
  return start <= end ? now >= start && now < end : now >= start || now < end;
}

/**
 * Offers a notification. kind: "needs" (it waits on this person), "agent" (an update from an agent)
 * or "mention" (a person mentioned them).
 */
export function offer(kind, item, onOpen) {
  if (settings.notifyLevel === 'off') return;
  if (kind === 'mention' && settings.notifyLevel !== 'all') return;
  if (inQuietHours()) {
    held.push({ kind, item });
    return;
  }
  if (kind === 'agent') {
    batch.push(item);
    if (!batchTimer) batchTimer = setTimeout(() => flushBatch(onOpen), BATCH_MS);
    return;
  }
  void show(item, onOpen);
}

function flushBatch(onOpen) {
  batchTimer = null;
  const items = batch;
  batch = [];
  if (!items.length) return;
  if (items.length === 1) return void show(items[0], onOpen);
  void show({ title: `${items.length} updates from agents`, body: items.map((i) => i.title).slice(0, 3).join(' · '), tag: 'agent-batch', hash: '#!needs' }, onOpen);
}

/** Called every minute: when quiet hours end, what was held arrives as one summary. */
export function tick() {
  if (inQuietHours() || held.length === 0) return;
  const needs = held.filter((h) => h.kind === 'needs').length;
  const rest = held.length - needs;
  held = [];
  void show(
    {
      title: 'While you were away',
      body: [needs ? `${needs} need${needs === 1 ? 's' : ''} you` : null, rest ? `${rest} update${rest === 1 ? '' : 's'}` : null].filter(Boolean).join(' · '),
      tag: 'quiet-summary',
      hash: '#!needs',
    },
    onOpenHeld,
  );
}
