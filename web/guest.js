// A guest's view of one shared ticket (#117): its title, status and comments, refreshed every few
// seconds, and a box to ask something (with a photo). What the guest writes waits for someone in the
// project to send it on. Built with textContent only: everything here comes from other people.

const token = location.hash.slice(1);
// Keep the token out of the address bar and history once read.
history.replaceState(null, '', location.pathname);
const root = document.getElementById('guest');
const base = `/guest-api/${encodeURIComponent(token)}`;
let photo = null;
let draft = '';

function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === null || value === undefined || value === false) continue;
    if (key === 'text') node.textContent = value;
    else if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
    else node.setAttribute(key, value === true ? '' : value);
  }
  for (const child of children.flat()) if (child !== null && child !== undefined) node.append(child);
  return node;
}

async function load() {
  const res = await fetch(base, { credentials: 'same-origin' });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    root.replaceChildren(el('h1', { text: 'This link has ended' }), el('p', { class: 'muted', text: data.error || 'Ask whoever shared it for a new one.' }));
    return false;
  }
  render(data);
  return true;
}

function render(t) {
  const box = el('textarea', { rows: '3', placeholder: 'Ask something about this ticket', 'aria-label': 'Your question', maxlength: '2000' });
  box.value = draft;
  box.addEventListener('input', () => (draft = box.value));
  const file = el('input', { type: 'file', accept: 'image/*', capture: 'environment', 'aria-label': 'Add a photo' });
  const status = el('p', { class: 'small muted', 'aria-live': 'polite' });
  file.addEventListener('change', () => {
    const f = file.files[0];
    if (!f) return;
    if (f.size > 5 * 1024 * 1024) {
      status.textContent = 'Photos can be at most 5 MB';
      file.value = '';
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      photo = reader.result;
      status.textContent = `Photo added: ${f.name}`;
    };
    reader.readAsDataURL(f);
  });
  const send = el('button', {
    class: 'primary',
    type: 'button',
    text: 'Send',
    onclick: async () => {
      send.disabled = true;
      status.textContent = 'Sending…';
      const res = await fetch(`${base}/requests`, { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: box.value, photo }) });
      const data = await res.json().catch(() => ({}));
      send.disabled = false;
      if (!res.ok) {
        status.textContent = data.error || 'Could not send it';
        return;
      }
      draft = '';
      photo = null;
      await load();
    },
  });
  root.replaceChildren(
    el('p', { class: 'small muted', text: `Shared ticket ${t.ref} · link works until ${new Date(t.expiresAt).toLocaleString()}` }),
    el('h1', { class: 'guest-title', text: t.title }),
    el('p', {}, el('span', { class: 'chip', text: t.status }), t.nextStep ? el('span', { class: 'small', text: ` Next: ${t.nextStep}` }) : null),
    t.waitingOn ? el('p', { class: 'small', text: `Waiting on: ${t.waitingOn}` }) : null,
    el('h2', { class: 'small', text: 'Updates' }),
    t.comments.length
      ? el('ol', { class: 'guest-comments' }, t.comments.map((c) => el('li', {}, el('div', { class: 'small muted', text: `${c.by}${c.kind === 'agent' ? ' (agent)' : ''} · ${new Date(c.at).toLocaleString()}` }), el('div', { class: 'guest-text', text: c.text }))))
      : el('p', { class: 'muted small', text: 'No updates yet.' }),
    t.requests.length
      ? el(
          'div',
          {},
          el('h2', { class: 'small', text: 'What you asked' }),
          el('ul', { class: 'guest-comments' }, t.requests.map((r) => el('li', {}, el('div', { class: 'guest-text', text: r.text || '(a photo)' }), el('div', { class: 'small muted', text: r.state === 'pending' ? 'Waiting for the team to pass it on' : r.state === 'sent' ? 'Passed on to the team' : 'Not passed on' })))),
        )
      : null,
    el('div', { class: 'guest-ask' }, box, el('div', { class: 'row-end' }, file, send), status),
  );
}

if (!token) root.replaceChildren(el('h1', { text: 'No link' }), el('p', { class: 'muted', text: 'Open the full link you were sent.' }));
else if (await load()) {
  setInterval(() => {
    if (!document.activeElement || document.activeElement.tagName !== 'TEXTAREA') void load();
  }, 10_000);
}
