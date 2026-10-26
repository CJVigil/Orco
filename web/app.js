const $ = (id) => document.getElementById(id);
const MENTION = /(@[a-z0-9][a-z0-9-]{0,31})\b|(https?:\/\/[^\s<>"]+)/g;
const GROUP_MS = 5 * 60 * 1000;
const PAGE = 50;

const state = {
  me: null,
  projects: [],
  rooms: [],
  room: null,
  messages: [],
  thread: null,
  threadMessages: [],
  panel: null,
  unread: new Map(),
  mentioned: new Map(),
};

class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

async function api(path, options = {}) {
  const res = await fetch(`/api${path}`, {
    ...options,
    headers: options.body ? { 'Content-Type': 'application/json' } : undefined,
    body: options.body ? JSON.stringify(options.body) : undefined,
    credentials: 'same-origin',
  });
  if (res.status === 204) return null;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, data.error || res.statusText);
  return data;
}

function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
    else node.setAttribute(key, value === true ? '' : value);
  }
  for (const child of children.flat()) if (child !== null && child !== undefined) node.append(child);
  return node;
}

function hue(name) {
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) % 360;
  return h;
}

function avatar(name, kind) {
  const node = el('span', { class: `avatar ${kind === 'agent' ? 'agent' : ''}`, 'aria-hidden': 'true', text: name[0].toUpperCase() });
  node.style.background = `hsl(${hue(name)} 70% 72%)`;
  return node;
}

function formatTime(iso) {
  const date = new Date(iso);
  const now = new Date();
  const time = date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  if (date.toDateString() === now.toDateString()) return time;
  return `${date.toLocaleDateString([], { month: 'short', day: 'numeric' })} ${time}`;
}

function richText(text) {
  const nodes = [];
  let last = 0;
  for (const match of text.matchAll(MENTION)) {
    if (match.index > last) nodes.push(text.slice(last, match.index));
    if (match[1]) {
      const name = match[1].slice(1);
      nodes.push(el('span', { class: 'mention', text: match[1], title: name === state.me.name ? 'You' : name }));
    } else {
      nodes.push(el('a', { href: match[2], target: '_blank', rel: 'noopener noreferrer', text: match[2] }));
    }
    last = match.index + match[0].length;
  }
  if (last < text.length) nodes.push(text.slice(last));
  return nodes;
}

function renderMessage(message, previous, { inThread = false } = {}) {
  seen.add(message.id);
  const continued =
    previous &&
    previous.author === message.author &&
    new Date(message.createdAt) - new Date(previous.createdAt) < GROUP_MS;
  const mentionsMe = message.mentions.includes(state.me.name);
  const node = el(
    'li',
    {
      class: `msg${continued ? ' continued' : ''}${mentionsMe ? ' mentions-me' : ''}`,
      'data-id': message.id,
    },
    avatar(message.author, message.authorKind),
    el(
      'div',
      { class: 'msg-head' },
      el('span', { class: 'author', text: message.author }),
      message.authorKind === 'agent' ? el('span', { class: 'tag', text: 'Agent' }) : null,
      message.owner ? el('span', { class: 'owner', text: `owned by ${message.owner}` }) : null,
      el('time', { class: 'time', datetime: message.createdAt, title: new Date(message.createdAt).toLocaleString(), text: formatTime(message.createdAt) }),
    ),
    el('div', { class: 'msg-body' }, richText(message.text)),
    message.task ? taskCard(message) : null,
  );
  if (!inThread) {
    node.append(
      el('div', { class: 'msg-actions' }, el('button', { class: 'ghost small', type: 'button', text: 'Reply in thread', onclick: () => openThread(message) })),
    );
    if (message.replyCount > 0) {
      node.append(
        el('button', {
          class: 'ghost replies',
          type: 'button',
          text: `${message.replyCount} ${message.replyCount === 1 ? 'reply' : 'replies'}`,
          onclick: () => openThread(message),
        }),
      );
    }
  }
  return node;
}

const TASK_LABEL = {
  requested: 'Requested',
  accepted: 'In progress',
  done: 'Done',
  failed: 'Failed',
  declined: 'Declined',
  cancelled: 'Cancelled',
};

function taskCard(message) {
  const { id, state: taskState, assignee } = message.task;
  const open = taskState === 'requested' || taskState === 'accepted';
  const mine = message.author === state.me.name || message.owner === state.me.name;
  return el(
    'div',
    { class: `task-card task-${taskState}` },
    el('span', { class: 'task-id', text: `Task #${id}` }),
    el('span', { class: 'muted', text: `→ ${assignee}` }),
    el('span', { class: 'chip', text: TASK_LABEL[taskState] }),
    open && mine
      ? el('button', {
          class: 'ghost small',
          type: 'button',
          text: 'Cancel',
          onclick: async () => {
            if (!confirm(`Cancel task #${id}?`)) return;
            try {
              await api(`/tasks/${id}`, { method: 'POST', body: { state: 'cancelled' } });
            } catch (err) {
              alert(err.message);
            }
          },
        })
      : null,
  );
}

function onTask(task) {
  let touched = false;
  for (const list of [state.messages, state.threadMessages]) {
    for (const message of list) {
      if (message.task && message.task.id === task.id) {
        message.task = { id: task.id, state: task.state, assignee: task.assignee };
        touched = true;
      }
    }
  }
  if (!touched) return;
  renderMessages({ keepScroll: true });
  if (state.panel === 'thread') renderThread({ keepScroll: true });
}

/* Sidebar */

function roomLink(room) {
  const unread = state.unread.get(room.ref) || 0;
  const mentioned = state.mentioned.get(room.ref) || 0;
  return el(
    'a',
    {
      class: `room-link${unread ? ' unread' : ''}`,
      href: `#${room.ref}`,
      'aria-current': state.room?.ref === room.ref ? 'page' : null,
      onclick: () => $('sidebar').classList.remove('open'),
    },
    el('span', { class: 'hash', text: '#' }),
    el('span', { text: room.name }),
    mentioned ? el('span', { class: 'badge', text: String(mentioned), title: 'Mentions' }) : null,
  );
}

function renderNav() {
  const nav = $('nav');
  nav.replaceChildren();
  const serverRooms = state.rooms.filter((r) => r.project === null);
  nav.append(el('div', { class: 'nav-group' }, el('div', { class: 'nav-group-head', text: 'Server' }), serverRooms.map(roomLink)));
  for (const project of state.projects) {
    const rooms = state.rooms.filter((r) => r.project === project.name);
    nav.append(
      el(
        'div',
        { class: 'nav-group' },
        el(
          'div',
          { class: 'nav-group-head' },
          el('span', { text: project.name }),
          el('button', { class: 'ghost', type: 'button', title: `New room in ${project.name}`, 'aria-label': `New room in ${project.name}`, text: '+', onclick: () => newRoom(project.name) }),
        ),
        rooms.map(roomLink),
      ),
    );
  }
}

async function loadStructure() {
  [state.projects, state.rooms] = await Promise.all([api('/projects'), api('/rooms')]);
  renderNav();
}

/* Rooms */

function roomFromHash() {
  const ref = decodeURIComponent(location.hash.slice(1));
  return state.rooms.find((r) => r.ref === ref) || state.rooms.find((r) => r.ref === 'lobby') || state.rooms[0];
}

function renderRoomTitle() {
  const title = $('room-title');
  title.replaceChildren();
  if (state.room.project) title.append(el('span', { class: 'project', text: `${state.room.project} / ` }));
  title.append(`#${state.room.name}`);
  $('add-member').hidden = !state.room.project;
  $('show-locks').hidden = !state.room.project;
  document.title = `#${state.room.name} · Orco`;
}

function renderMessages({ keepScroll = false } = {}) {
  const box = $('messages');
  const fromBottom = box.scrollHeight - box.scrollTop;
  const list = $('message-list');
  list.replaceChildren(...state.messages.map((m, i) => renderMessage(m, state.messages[i - 1])));
  $('empty').hidden = state.messages.length > 0;
  if (keepScroll) box.scrollTop = box.scrollHeight - fromBottom;
  else box.scrollTop = box.scrollHeight;
}

async function selectRoom() {
  const room = roomFromHash();
  if (!room) return;
  const changed = state.room?.ref !== room.ref;
  state.room = room;
  state.unread.delete(room.ref);
  state.mentioned.delete(room.ref);
  renderNav();
  renderRoomTitle();
  if (changed) {
    state.messages = await api(`/messages?room=${encodeURIComponent(room.ref)}&top_level=1&limit=${PAGE}`);
    $('load-older').hidden = state.messages.length < PAGE;
    renderMessages();
    if (state.panel === 'members') showMembers();
    else if (state.panel === 'locks' && state.room.project) showLocks();
    else closePanel();
    $('composer-text').focus();
  }
}

async function loadOlder() {
  const oldest = state.messages[0];
  if (!oldest) return;
  const older = await api(`/messages?room=${encodeURIComponent(state.room.ref)}&top_level=1&limit=${PAGE}&before_id=${oldest.id}`);
  $('load-older').hidden = older.length < PAGE;
  state.messages = [...older, ...state.messages];
  renderMessages({ keepScroll: true });
}

/* Threads and members panel */

function openPanel(kind, title) {
  if (kind !== 'locks') clearInterval(lockTimer);
  state.panel = kind;
  $('panel').hidden = false;
  $('panel-title').textContent = title;
  $('thread-composer').hidden = kind !== 'thread';
}

function closePanel() {
  state.panel = null;
  state.thread = null;
  clearInterval(lockTimer);
  $('panel').hidden = true;
}

let lockTimer = null;

function timeLeft(iso) {
  const seconds = Math.max(0, Math.round((new Date(iso) - Date.now()) / 1000));
  if (seconds < 90) return `${seconds}s`;
  if (seconds < 90 * 60) return `${Math.round(seconds / 60)}m`;
  return `${Math.floor(seconds / 3600)}h ${Math.round((seconds % 3600) / 60)}m`;
}

async function releaseLock(lock, force) {
  const question = force
    ? `Force-release ${lock.name}? ${lock.holder} may still be using it. This is posted in #general.`
    : `Release ${lock.name}?`;
  if (!confirm(question)) return;
  try {
    await api('/locks/release', { method: 'POST', body: { project: lock.project, name: lock.name, force } });
  } catch (err) {
    alert(err.message);
  }
}

async function takeLock() {
  const project = state.room.project;
  await ask({
    title: `Take a lock in ${project}`,
    label: 'Lock name',
    hint: 'Like deploy:prod or account:agentic. You hold it for 30 minutes; take it again to extend.',
    submit: (name) => api('/locks', { method: 'POST', body: { project, name, ttl_seconds: 1800 } }),
  });
}

async function showLocks() {
  const project = state.room.project;
  if (!project) return closePanel();
  if (state.panel !== 'locks') {
    openPanel('locks', `${project} locks`);
    clearInterval(lockTimer);
    lockTimer = setInterval(() => {
      if (state.panel === 'locks') void showLocks();
    }, 15_000);
  }
  const locks = await api(`/locks?project=${encodeURIComponent(project)}`);
  if (state.panel !== 'locks') return;
  const rows = locks.map((lock) => {
    const mine = lock.holder === state.me.name || lock.holderOwner === state.me.name;
    return el(
      'div',
      { class: 'lock' },
      el(
        'div',
        { class: 'lock-main' },
        el('span', { class: 'lock-name', text: lock.name }),
        el('span', { class: 'sub', text: `${lock.holder}${lock.holderOwner ? ` · ${lock.holderOwner}'s agent` : ''}` }),
        lock.note ? el('span', { class: 'sub', text: lock.note }) : null,
        el('span', { class: 'sub', text: `Fence ${lock.fence} · expires in ${timeLeft(lock.expiresAt)}`, title: lock.expiresAt }),
      ),
      el('button', {
        class: 'ghost small',
        type: 'button',
        text: mine ? 'Release' : 'Force release',
        onclick: () => void releaseLock(lock, !mine),
      }),
    );
  });
  $('panel-body').replaceChildren(
    el('div', { class: 'panel-actions' }, el('button', { class: 'ghost small', type: 'button', text: '+ Take a lock', onclick: () => void takeLock() })),
    rows.length ? el('div', {}, rows) : el('p', { class: 'empty muted', text: 'No locks held. Agents take locks with acquire_lock before touching shared things.' }),
  );
}

function renderThread({ keepScroll = false } = {}) {
  const items = state.threadMessages;
  const [root, ...replies] = items;
  const list = el('ol', { class: 'message-list' });
  if (root) list.append(renderMessage(root, null, { inThread: true }));
  list.append(el('li', { class: 'thread-divider', text: `${replies.length} ${replies.length === 1 ? 'reply' : 'replies'}` }));
  replies.forEach((m, i) => list.append(renderMessage(m, replies[i - 1], { inThread: true })));
  const body = $('panel-body');
  const top = body.scrollTop;
  body.replaceChildren(list);
  body.scrollTop = keepScroll ? top : body.scrollHeight;
}

async function openThread(message) {
  state.thread = message;
  openPanel('thread', 'Thread');
  state.threadMessages = await api(`/messages?room=${encodeURIComponent(message.room)}&thread_id=${message.id}&limit=200`);
  renderThread();
  $('thread-text').focus();
}

const STATUS_TEXT = { online: 'Online', listening: 'Listening for mentions', offline: 'Offline' };

async function showMembers() {
  openPanel('members', state.room.project ? `${state.room.project} members` : 'Everyone');
  const people = await api(`/participants${state.room.project ? `?project=${encodeURIComponent(state.room.project)}` : ''}`);
  if (state.panel !== 'members') return;
  const order = { listening: 0, online: 1, offline: 2 };
  const sorted = (kind) => people.filter((p) => p.kind === kind).sort((a, b) => order[a.status] - order[b.status] || a.name.localeCompare(b.name));
  const row = (p) => {
    const face = avatar(p.name, p.kind);
    face.append(el('span', { class: `dot ${p.status}` }));
    return el(
      'div',
      { class: `member ${p.status}` },
      face,
      el('div', { class: 'member-info' }, el('span', { text: p.name }), el('span', { class: 'sub', text: p.owner ? `${STATUS_TEXT[p.status]} · ${p.owner}'s agent` : STATUS_TEXT[p.status] })),
    );
  };
  const humans = sorted('user');
  const agents = sorted('agent');
  $('panel-body').replaceChildren(
    el('div', { class: 'member-group', text: `People — ${humans.length}` }),
    ...humans.map(row),
    el('div', { class: 'member-group', text: `Agents — ${agents.length}` }),
    ...agents.map(row),
  );
}

/* Live updates */

const seen = new Set();

function onMessage(message) {
  if (seen.has(message.id)) return;
  seen.add(message.id);
  const here = state.room && message.room === state.room.ref;
  if (message.threadId === null) {
    if (here) {
      if (!state.messages.some((m) => m.id === message.id)) {
        const box = $('messages');
        const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 80;
        state.messages.push(message);
        renderMessages({ keepScroll: !atBottom });
      }
    }
  } else {
    const root = state.messages.find((m) => m.id === message.threadId);
    if (here && root) {
      root.replyCount += 1;
      renderMessages({ keepScroll: true });
    }
    if (state.thread && state.thread.id === message.threadId && !state.threadMessages.some((m) => m.id === message.id)) {
      state.threadMessages.push(message);
      renderThread();
    }
  }
  if (message.author === state.me.name) return;
  const visible = here && document.visibilityState === 'visible';
  if (!visible) {
    state.unread.set(message.room, (state.unread.get(message.room) || 0) + 1);
    if (message.mentions.includes(state.me.name)) state.mentioned.set(message.room, (state.mentioned.get(message.room) || 0) + 1);
    renderNav();
  }
}

let presenceTimer = null;

function connect() {
  const events = new EventSource('/api/events');
  const dot = $('connection');
  events.addEventListener('ready', () => {
    dot.classList.add('live');
    dot.title = 'Live';
  });
  events.addEventListener('message', (event) => onMessage(JSON.parse(event.data)));
  events.addEventListener('structure', async () => {
    await loadStructure();
    await selectRoom();
  });
  events.addEventListener('task', (event) => onTask(JSON.parse(event.data)));
  events.addEventListener('locks', () => {
    if (state.panel === 'locks') void showLocks();
  });
  events.addEventListener('presence', () => {
    if (state.panel !== 'members') return;
    clearTimeout(presenceTimer);
    presenceTimer = setTimeout(() => void showMembers(), 300);
  });
  events.onerror = () => {
    dot.classList.remove('live');
    dot.title = 'Reconnecting…';
  };
}

/* Dialog */

function ask({ title, label, hint, value = '', submit }) {
  const dialog = $('ask');
  $('ask-title').textContent = title;
  $('ask-label').textContent = label;
  $('ask-hint').textContent = hint || '';
  $('ask-error').hidden = true;
  const input = $('ask-input');
  input.value = value;
  dialog.showModal();
  input.focus();
  return new Promise((resolve) => {
    const form = $('ask-form');
    const finish = (result) => {
      form.removeEventListener('submit', onSubmit);
      $('ask-cancel').removeEventListener('click', onCancel);
      dialog.removeEventListener('cancel', onCancel);
      dialog.close();
      resolve(result);
    };
    const onCancel = () => finish(null);
    const onSubmit = async (event) => {
      event.preventDefault();
      try {
        finish(await submit(input.value.trim()));
      } catch (err) {
        $('ask-error').textContent = err.message;
        $('ask-error').hidden = false;
      }
    };
    form.addEventListener('submit', onSubmit);
    $('ask-cancel').addEventListener('click', onCancel);
    dialog.addEventListener('cancel', onCancel);
  });
}

const NAME_HINT = 'Lowercase letters, digits and dashes.';

async function newProject() {
  const project = await ask({
    title: 'New project',
    label: 'Project name',
    hint: `${NAME_HINT} You become a member, and a #general room is created.`,
    submit: (name) => api('/projects', { method: 'POST', body: { name } }),
  });
  if (!project) return;
  await loadStructure();
  location.hash = `${project.name}/general`;
}

async function newRoom(projectName) {
  const room = await ask({
    title: `New room in ${projectName}`,
    label: 'Room name',
    hint: NAME_HINT,
    submit: (name) => api(`/projects/${encodeURIComponent(projectName)}/rooms`, { method: 'POST', body: { name } }),
  });
  if (!room) return;
  await loadStructure();
  location.hash = room.ref;
}

async function addMember() {
  const project = state.room.project;
  const user = await ask({
    title: `Add someone to ${project}`,
    label: 'User name',
    hint: 'Their agents will be able to see this project’s rooms too.',
    submit: async (name) => {
      await api(`/projects/${encodeURIComponent(project)}/members`, { method: 'POST', body: { user: name } });
      return name;
    },
  });
  if (user && state.panel === 'members') showMembers();
}

/* Composer */

function autosize(textarea) {
  textarea.style.height = 'auto';
  textarea.style.height = `${textarea.scrollHeight}px`;
}

function wireComposer(form, textarea, send) {
  textarea.addEventListener('input', () => autosize(textarea));
  textarea.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      form.requestSubmit();
    }
  });
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const text = textarea.value.trim();
    if (!text) return;
    textarea.disabled = true;
    try {
      const message = await send(text);
      textarea.value = '';
      autosize(textarea);
      if (message) onMessage(message);
    } catch (err) {
      alert(err.message);
    } finally {
      textarea.disabled = false;
      textarea.focus();
    }
  });
}

/* Boot */

async function start() {
  try {
    state.me = await api('/me');
  } catch (err) {
    if (err.status === 401) return showLogin();
    throw err;
  }
  $('login').hidden = true;
  $('app').hidden = false;
  $('me-name').textContent = state.me.name;
  $('me-avatar').replaceWith(Object.assign(avatar(state.me.name, state.me.kind), { id: 'me-avatar' }));
  await loadStructure();
  await selectRoom();
  connect();
}

function showLogin() {
  $('app').hidden = true;
  $('login').hidden = false;
  $('login-token').focus();
}

$('login-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  try {
    await api('/session', { method: 'POST', body: { token: $('login-token').value.trim() } });
    $('login-token').value = '';
    $('login-error').hidden = true;
    await start();
  } catch (err) {
    $('login-error').textContent = err.message;
    $('login-error').hidden = false;
  }
});

$('logout').addEventListener('click', async () => {
  await api('/session', { method: 'DELETE' });
  location.reload();
});

$('new-project').addEventListener('click', () => void newProject());
$('add-member').addEventListener('click', () => void addMember());
$('show-members').addEventListener('click', () => (state.panel === 'members' ? closePanel() : void showMembers()));
$('show-locks').addEventListener('click', () => (state.panel === 'locks' ? closePanel() : void showLocks()));
$('close-panel').addEventListener('click', closePanel);
$('load-older').addEventListener('click', () => void loadOlder());
$('toggle-sidebar').addEventListener('click', () => $('sidebar').classList.toggle('open'));
window.addEventListener('hashchange', () => void selectRoom());
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && state.room) {
    state.unread.delete(state.room.ref);
    state.mentioned.delete(state.room.ref);
    renderNav();
  }
});

const TASK_COMMAND = /^\/task\s+@?([a-z0-9][a-z0-9-]{0,31})\s+([\s\S]+)$/;

wireComposer($('composer'), $('composer-text'), async (text) => {
  if (text.startsWith('/task')) {
    const match = TASK_COMMAND.exec(text);
    if (!match) throw new Error('Use /task @agent what you need');
    await api('/tasks', { method: 'POST', body: { agent: match[1], room: state.room.ref, request: match[2] } });
    return null;
  }
  return api('/messages', { method: 'POST', body: { room: state.room.ref, text } });
});
wireComposer($('thread-composer'), $('thread-text'), (text) =>
  api('/messages', { method: 'POST', body: { room: state.thread.room, text, thread_id: state.thread.id } }),
);

start().catch((err) => {
  document.body.textContent = `Orco failed to load: ${err.message}`;
});
