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
