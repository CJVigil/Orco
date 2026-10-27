import { attachMentionAutocomplete } from './autocomplete.js';
import { icon } from './icons.js';
import { renderMarkdown } from './markdown.js';

const $ = (id) => document.getElementById(id);
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

for (const node of document.querySelectorAll('[data-icon]')) node.prepend(icon(node.dataset.icon));

function hue(name) {
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) % 360;
  return h;
}

function avatar(name, kind) {
  const node = el('span', { class: `avatar ${kind === 'agent' ? 'agent' : ''}`, 'aria-hidden': 'true', text: name[0].toUpperCase() });
  const h = hue(name);
  node.style.background = kind === 'agent' ? `linear-gradient(135deg, hsl(${h} 72% 74%), hsl(${(h + 50) % 360} 65% 62%))` : `hsl(${h} 70% 72%)`;
  return node;
}

function formatTime(iso) {
  const date = new Date(iso);
  const now = new Date();
  const time = date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  if (date.toDateString() === now.toDateString()) return time;
  return `${date.toLocaleDateString([], { month: 'short', day: 'numeric' })} ${time}`;
}

function codeBlock(code, lang) {
  const copy = el('button', {
    class: 'ghost small code-copy',
    type: 'button',
    text: 'Copy',
    onclick: async () => {
      try {
        await navigator.clipboard.writeText(code);
        copy.textContent = 'Copied';
        setTimeout(() => (copy.textContent = 'Copy'), 1500);
      } catch {
        copy.textContent = 'Copy failed';
      }
    },
  });
  return el('div', { class: 'code-block' }, el('div', { class: 'code-head' }, el('span', { text: lang || 'text' }), copy), el('pre', {}, el('code', { text: code })));
}

function richText(text) {
  return renderMarkdown(text, {
    h: (tag, props, children) => el(tag, props, children),
    codeBlock,
    mention: (name) => el('span', { class: `mention${name === state.me.name ? ' mention-self' : ''}`, text: `@${name}`, title: name === state.me.name ? 'You' : name }),
  });
}

function dayLabel(iso) {
  const date = new Date(iso);
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  if (date.toDateString() === today.toDateString()) return 'Today';
  if (date.toDateString() === yesterday.toDateString()) return 'Yesterday';
  return date.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric', year: date.getFullYear() === today.getFullYear() ? undefined : 'numeric' });
}

function withDays(messages, render) {
  const out = [];
  messages.forEach((m, i) => {
    const prev = messages[i - 1];
    const newDay = !prev || new Date(prev.createdAt).toDateString() !== new Date(m.createdAt).toDateString();
    if (newDay) out.push(el('li', { class: 'day-divider', role: 'separator' }, el('span', { text: dayLabel(m.createdAt) })));
    out.push(render(m, newDay ? null : prev));
  });
  return out;
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
    el('div', { class: 'msg-body md' }, richText(message.text)),
    message.attachments?.length
      ? el(
          'div',
          { class: 'images' },
          message.attachments.map((image) =>
            el(
              'a',
              { href: `/api/attachments/${image.id}`, target: '_blank', rel: 'noopener', title: image.name },
              el('img', { src: `/api/attachments/${image.id}`, alt: image.name, loading: 'lazy' }),
            ),
          ),
        )
      : null,
    message.task ? taskCard(message) : null,
    message.approval ? approvalCard(message) : null,
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
  awaiting_approval: 'Waiting for owner',
  requested: 'Requested',
  accepted: 'In progress',
  done: 'Done',
  failed: 'Failed',
  declined: 'Declined',
  cancelled: 'Cancelled',
};

function elapsed(iso) {
  const seconds = Math.max(0, Math.round((Date.now() - new Date(iso)) / 1000));
  if (seconds < 45) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? `${hours}h ${minutes % 60}m` : `${Math.floor(hours / 24)}d`;
}

function liveElapsed(prefix, iso) {
  return el('span', { 'data-since': iso, 'data-prefix': prefix, text: `${prefix}${elapsed(iso)}` });
}

setInterval(() => {
  for (const node of document.querySelectorAll('[data-since]')) node.textContent = `${node.dataset.prefix}${elapsed(node.dataset.since)}`;
}, 30_000);

function taskCard(message) {
  const { id, state: taskState, assignee, since } = message.task;
  const open = taskState === 'awaiting_approval' || taskState === 'requested' || taskState === 'accepted';
  const mine = message.author === state.me.name || message.owner === state.me.name;
  return el(
    'div',
    { class: `task-card task-${taskState}` },
    el('span', { class: 'task-id', text: `Task #${id}` }),
    el('span', { class: 'muted', text: `→ ${assignee}` }),
    el(
      'span',
      { class: 'chip' },
      taskState === 'accepted' ? el('span', { class: 'working-dot', 'aria-hidden': 'true' }) : null,
      taskState === 'accepted' && since ? liveElapsed('In progress · ', since) : TASK_LABEL[taskState],
    ),
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

const APPROVAL_LABEL = { pending: 'Waiting for a decision', approved: 'Approved', denied: 'Denied', expired: 'Expired' };

function canDecide(message) {
  const { approver } = message.approval;
  if (state.me.kind !== 'user') return false;
  if (approver) return approver === state.me.name;
  return message.author !== state.me.name && message.owner !== state.me.name;
}

async function decideApproval(id, decision, alwaysAllow = false) {
  let note;
  if (decision === 'denied') {
    note = prompt('Reason (optional, shared with the requester)');
    if (note === null) return;
  }
  try {
    await api(`/approvals/${id}`, { method: 'POST', body: { decision, note: note || undefined, always_allow: alwaysAllow } });
  } catch (err) {
    alert(err.message);
  }
}

function decide(message, decision, alwaysAllow = false) {
  return decideApproval(message.approval.id, decision, alwaysAllow);
}

function approvalCard(message) {
  const { id, kind, state: approvalState, approver } = message.approval;
  const pending = approvalState === 'pending';
  const requesterHuman = message.owner || message.author;
  const buttons = pending && canDecide(message)
    ? [
        el('button', { class: 'primary small', type: 'button', text: 'Approve', onclick: () => void decide(message, 'approved') }),
        kind === 'task'
          ? el('button', {
              class: 'ghost small',
              type: 'button',
              text: `Approve & always allow ${requesterHuman}`,
              title: `Tasks from ${requesterHuman} and their agents will reach this agent without asking`,
              onclick: () => void decide(message, 'approved', true),
            })
          : null,
        el('button', { class: 'ghost small danger', type: 'button', text: 'Deny', onclick: () => void decide(message, 'denied') }),
      ]
    : [];
  return el(
    'div',
    { class: `approval-card approval-${approvalState}` },
    el('span', { class: 'task-id', text: kind === 'task' ? 'Owner approval' : `Approval #${id}` }),
    el('span', { class: 'chip', text: APPROVAL_LABEL[approvalState] }),
    pending && approver && !canDecide(message) ? el('span', { class: 'muted', text: `for ${approver}` }) : null,
    buttons,
  );
}

function onApproval(approval) {
  let touched = false;
  for (const list of [state.messages, state.threadMessages]) {
    for (const message of list) {
      if (message.approval && message.approval.id === approval.id) {
        message.approval = { id: approval.id, kind: approval.kind, state: approval.state, approver: approval.approver };
        touched = true;
      }
    }
  }
  if (!touched) return;
  renderMessages({ keepScroll: true });
  if (state.panel === 'thread') renderThread({ keepScroll: true });
}

const POLICY_TEXT = {
  ask: 'Ask me first',
  open: 'Anyone in a shared project',
  owner_only: 'Only me and my agents',
};

async function showMyAgents() {
  openPanel('agents', 'My agents');
  const agents = await api('/agents');
  if (state.panel !== 'agents') return;
  if (agents.length === 0) {
    $('panel-body').replaceChildren(el('p', { class: 'empty muted', text: 'You have no agents yet. A server admin adds one with orco agent add <you> <name>.' }));
    return;
  }
  $('panel-body').replaceChildren(
    el('p', { class: 'panel-intro muted small', text: 'Choose who may give each agent tasks. Tasks from your own agents always go through.' }),
    ...agents.map((agent) => {
      const select = el(
        'select',
        {
          'aria-label': `Who may give ${agent.name} tasks`,
          onchange: async (event) => {
            try {
              await api(`/agents/${encodeURIComponent(agent.name)}/policy`, { method: 'POST', body: { policy: event.target.value } });
            } catch (err) {
              alert(err.message);
            }
            void showMyAgents();
          },
        },
        Object.entries(POLICY_TEXT).map(([value, text]) => el('option', { value, text, selected: agent.taskPolicy === value })),
      );
      const trusted = agent.trusted.map((user) =>
        el(
          'li',
          {},
          el('span', { text: user }),
          el('button', {
            class: 'ghost small',
            type: 'button',
            text: 'Remove',
            onclick: async () => {
              await api(`/agents/${encodeURIComponent(agent.name)}/trust`, { method: 'POST', body: { user, trusted: false } });
              void showMyAgents();
            },
          }),
        ),
      );
      const connections = (agent.connections || []).map((c) =>
        el(
          'li',
          {},
          el('span', { text: c.client, title: `Connected ${new Date(c.createdAt).toLocaleString()}` }),
          el('span', { class: 'small muted', text: c.lastUsedAt ? `used ${formatTime(c.lastUsedAt)}` : 'not used yet' }),
          el('button', {
            class: 'ghost small danger',
            type: 'button',
            text: 'Revoke',
            onclick: async () => {
              if (!confirm(`Disconnect ${c.client} from ${agent.name}? It will need to sign in again.`)) return;
              await api(`/connections/${c.id}/revoke`, { method: 'POST', body: {} });
              void showMyAgents();
            },
          }),
        ),
      );
      return el(
        'section',
        { class: 'agent-settings' },
        el('div', { class: 'agent-name' }, avatar(agent.name, 'agent'), el('strong', { text: agent.name })),
        connections.length
          ? el('div', { class: 'trusted' }, el('span', { class: 'small muted', text: 'Connected apps:' }), el('ul', { class: 'connections' }, connections))
          : null,
        el('label', { class: 'small', text: 'Who may give it tasks' }),
        select,
        agent.taskPolicy === 'ask'
          ? el(
              'div',
              { class: 'trusted' },
              el('span', { class: 'small muted', text: trusted.length ? 'Always allowed without asking:' : 'No one is pre-approved.' }),
              trusted.length ? el('ul', {}, trusted) : null,
              el('button', {
                class: 'ghost small',
                type: 'button',
                text: '+ Always allow someone',
                onclick: async () => {
                  await ask({
                    title: `Always allow tasks for ${agent.name}`,
                    label: 'User name',
                    hint: 'Tasks from this person and their agents will start without asking you.',
                    submit: (user) => api(`/agents/${encodeURIComponent(agent.name)}/trust`, { method: 'POST', body: { user, trusted: true } }),
                  });
                  void showMyAgents();
                },
              }),
            )
          : null,
      );
    }),
  );
}

function onTask(task) {
  let touched = false;
  for (const list of [state.messages, state.threadMessages]) {
    for (const message of list) {
      if (message.task && message.task.id === task.id) {
        message.task = { id: task.id, state: task.state, assignee: task.assignee, since: task.updatedAt };
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
          el('button', { class: 'ghost', type: 'button', title: `New room in ${project.name}`, 'aria-label': `New room in ${project.name}`, onclick: () => newRoom(project.name) }, icon('plus')),
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
  const audit = $('audit-log');
  audit.hidden = !state.room.project;
  if (state.room.project) audit.href = `/api/audit?project=${encodeURIComponent(state.room.project)}&format=jsonl`;
  document.title = `#${state.room.name} · Orco`;
  $('empty-title').textContent = `This is the start of #${state.room.name}`;
}

function renderMessages({ keepScroll = false } = {}) {
  const box = $('messages');
  const fromBottom = box.scrollHeight - box.scrollTop;
  const list = $('message-list');
  list.replaceChildren(...withDays(state.messages, (m, prev) => renderMessage(m, prev)));
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
    state.roomLoad = (async () => {
      const messages = await api(`/messages?room=${encodeURIComponent(room.ref)}&top_level=1&limit=${PAGE}`);
      if (state.room.ref !== room.ref) return;
      state.messages = messages;
      $('load-older').hidden = state.messages.length < PAGE;
      renderMessages();
      if (state.panel === 'members') showMembers();
      else if (state.panel === 'locks' && state.room.project) showLocks();
      else if (state.panel === 'thread' || state.panel === 'locks') closePanel();
      $('composer-text').focus();
    })();
  }
  await state.roomLoad;
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
  $('thread-pending').hidden = kind !== 'thread';
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
  list.append(...withDays(replies, (m, prev) => renderMessage(m, prev, { inThread: true })));
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

const STATUS_TEXT = { online: 'Online', listening: 'Listening for mentions', standby: 'Standby · wakes on tasks', offline: 'Offline' };

async function showMembers() {
  openPanel('members', state.room.project ? `${state.room.project} members` : 'Everyone');
  const people = await api(`/participants${state.room.project ? `?project=${encodeURIComponent(state.room.project)}` : ''}`);
  if (state.panel !== 'members') return;
  const order = { listening: 0, online: 1, standby: 2, offline: 3 };
  const sorted = (kind) =>
    people
      .filter((p) => p.kind === kind)
      .sort((a, b) => Number(!a.working) - Number(!b.working) || order[a.status] - order[b.status] || a.name.localeCompare(b.name));
  const row = (p) => {
    const face = avatar(p.name, p.kind);
    face.append(el('span', { class: `dot ${p.status}` }));
    const sub = p.owner ? `${STATUS_TEXT[p.status]} · ${p.owner}'s agent` : STATUS_TEXT[p.status];
    const working = p.working
      ? el(
          'button',
          { class: 'member-working', type: 'button', title: p.working.request, onclick: () => void jumpTo({ id: p.working.messageId, room: p.working.room, threadId: null }) },
          el('span', { class: 'working-dot', 'aria-hidden': 'true' }),
          liveElapsed(`Working on #${p.working.taskId} · `, p.working.since),
        )
      : null;
    return el(
      'div',
      { class: `member ${p.status}${p.working ? ' working' : ''}` },
      face,
      el('div', { class: 'member-info' }, el('span', { text: p.name }), el('span', { class: 'sub', text: sub }), working),
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
  if (message.mentions.includes(state.me.name)) scheduleInbox();
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
    peopleCache.clear();
    await loadStructure();
    await selectRoom();
  });
  events.addEventListener('task', (event) => {
    onTask(JSON.parse(event.data));
    scheduleInbox();
    if (state.panel === 'members') {
      clearTimeout(presenceTimer);
      presenceTimer = setTimeout(() => void showMembers(), 300);
    }
  });
  events.addEventListener('approval', (event) => {
    onApproval(JSON.parse(event.data));
    scheduleInbox();
  });
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

const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_IMAGES = 4;

async function uploadImage(file, room) {
  const res = await fetch(`/api/attachments?room=${encodeURIComponent(room)}&name=${encodeURIComponent(file.name || 'image')}`, {
    method: 'POST',
    headers: { 'Content-Type': file.type || 'application/octet-stream' },
    body: file,
    credentials: 'same-origin',
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data.id;
}

function wireComposer(form, textarea, pendingEl, roomOf, send) {
  const pending = [];
  const fileInput = form.querySelector('.attach-input');
  const renderPending = () => {
    pendingEl.replaceChildren(
      ...pending.map((item, i) =>
        el(
          'div',
          { class: 'pending-item' },
          el('img', { src: item.url, alt: item.file.name || 'image' }),
          el('button', {
            type: 'button',
            'aria-label': `Remove ${item.file.name || 'image'}`,
            onclick: () => {
              URL.revokeObjectURL(item.url);
              pending.splice(i, 1);
              renderPending();
            },
          }, icon('x')),
        ),
      ),
    );
  };
  const addFiles = (files) => {
    for (const file of files) {
      if (!IMAGE_TYPES.includes(file.type)) {
        alert(`${file.name || 'That file'} is not a PNG, JPEG, GIF or WebP image.`);
        continue;
      }
      if (file.size > MAX_IMAGE_BYTES) {
        alert(`${file.name || 'That image'} is over 5 MB.`);
        continue;
      }
      if (pending.length >= MAX_IMAGES) {
        alert('You can attach up to 4 images.');
        break;
      }
      pending.push({ file, url: URL.createObjectURL(file) });
    }
    renderPending();
  };
  form.querySelector('.attach').addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', () => {
    addFiles([...fileInput.files]);
    fileInput.value = '';
  });
  textarea.addEventListener('paste', (event) => {
    const files = [...(event.clipboardData?.files || [])];
    if (files.length) {
      event.preventDefault();
      addFiles(files);
    }
  });
  form.addEventListener('dragover', (event) => {
    if ([...(event.dataTransfer?.items || [])].some((i) => i.kind === 'file')) {
      event.preventDefault();
      form.classList.add('dragging');
    }
  });
  form.addEventListener('dragleave', () => form.classList.remove('dragging'));
  form.addEventListener('drop', (event) => {
    form.classList.remove('dragging');
    if (event.dataTransfer?.files?.length) {
      event.preventDefault();
      addFiles([...event.dataTransfer.files]);
    }
  });
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
    if (!text && pending.length === 0) return;
    textarea.disabled = true;
    try {
      const room = roomOf();
      const ids = [];
      for (const item of pending) ids.push(await uploadImage(item.file, room));
      const message = await send(text, ids);
      textarea.value = '';
      autosize(textarea);
      for (const item of pending) URL.revokeObjectURL(item.url);
      pending.length = 0;
      renderPending();
      if (message) onMessage(message);
    } catch (err) {
      alert(err.message);
    } finally {
      textarea.disabled = false;
      textarea.focus();
    }
  });
}

const THEMES = ['system', 'light', 'dark'];
const THEME_LABEL = { system: 'System', light: 'Light', dark: 'Dark' };
const THEME_ICON = { system: 'monitor', light: 'sun', dark: 'moon' };

function readTheme() {
  try {
    return THEMES.includes(localStorage.getItem('orco-theme')) ? localStorage.getItem('orco-theme') : 'system';
  } catch {
    return 'system';
  }
}

function applyTheme(theme) {
  if (theme === 'system') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.setAttribute('data-theme', theme);
  const button = $('theme');
  button.replaceChildren(icon(THEME_ICON[theme]));
  button.setAttribute('aria-label', `Theme: ${THEME_LABEL[theme]}`);
  button.title = `Theme: ${THEME_LABEL[theme]} (click to change)`;
}

applyTheme(readTheme());
$('theme').addEventListener('click', () => {
  const next = THEMES[(THEMES.indexOf(readTheme()) + 1) % THEMES.length];
  try {
    localStorage.setItem('orco-theme', next);
  } catch {
    // Without storage the choice lasts until the page reloads.
  }
  applyTheme(next);
});

const peopleCache = new Map();

async function roomPeople(room) {
  const key = room?.project ?? '';
  if (!peopleCache.has(key)) {
    peopleCache.set(
      key,
      api(`/participants${key ? `?project=${encodeURIComponent(key)}` : ''}`).catch(() => {
        peopleCache.delete(key);
        return [];
      }),
    );
  }
  return (await peopleCache.get(key)).filter((p) => p.name !== state.me.name);
}

attachMentionAutocomplete($('composer-text'), () => roomPeople(state.room), el);
attachMentionAutocomplete($('thread-text'), () => roomPeople(state.rooms.find((r) => r.ref === state.thread?.room)), el);

/* Inbox and search */

let inboxTimer = null;

function scheduleInbox() {
  clearTimeout(inboxTimer);
  inboxTimer = setTimeout(() => void refreshInbox(), 250);
}

async function refreshInbox() {
  const inbox = await api('/inbox').catch(() => null);
  if (!inbox) return;
  const count = inbox.counts.approvals + inbox.counts.unseenMentions;
  const badge = $('inbox-badge');
  badge.hidden = count === 0;
  badge.textContent = String(count);
  $('inbox').classList.toggle('has-items', count > 0);
  if (state.panel === 'inbox') renderInbox(inbox);
}

function snippet(text, max = 160) {
  const flat = text
    .replace(/```[\w+#.-]*\n?/g, '')
    .replace(/(\*\*|__|~~|`)/g, '')
    .replace(/^\s{0,3}(#{1,3}|>|[-*+]|\d+[.)])\s+/gm, '')
    .replace(/\s+/g, ' ')
    .trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function messageRow(message, { unseen = false } = {}) {
  return el(
    'button',
    { class: `inbox-row${unseen ? ' unseen' : ''}`, type: 'button', onclick: () => void jumpTo(message) },
    el(
      'span',
      { class: 'inbox-meta' },
      el('strong', { text: message.author }),
      el('span', { class: 'muted', text: ` in #${message.room}` }),
      el('time', { class: 'muted', text: ` · ${formatTime(message.createdAt)}` }),
    ),
    el('span', { class: 'inbox-text', text: snippet(message.text) || '(image)' }),
  );
}

function renderInbox(inbox) {
  const sections = [];
  if (inbox.approvals.length) {
    sections.push(
      el('h3', { class: 'inbox-heading', text: `Needs your decision — ${inbox.approvals.length}` }),
      ...inbox.approvals.map((a) =>
        el(
          'div',
          { class: 'inbox-card' },
          el(
            'button',
            { class: 'inbox-row', type: 'button', onclick: () => void jumpTo({ id: a.messageId, room: a.room, threadId: null }) },
            el('span', { class: 'inbox-meta' }, el('strong', { text: a.requester }), el('span', { class: 'muted', text: ` in #${a.room}` })),
            el('span', { class: 'inbox-text', text: a.kind === 'task' ? `Task for your agent: ${a.summary}` : a.summary }),
          ),
          el(
            'div',
            { class: 'row-end' },
            el('button', { class: 'ghost small danger', type: 'button', text: 'Deny', onclick: () => void decideApproval(a.id, 'denied') }),
            el('button', { class: 'primary small', type: 'button', text: 'Approve', onclick: () => void decideApproval(a.id, 'approved') }),
          ),
        ),
      ),
    );
  }
  if (inbox.tasks.length) {
    sections.push(
      el('h3', { class: 'inbox-heading', text: state.me.kind === 'user' ? `Your agents' open tasks — ${inbox.tasks.length}` : `Your open tasks — ${inbox.tasks.length}` }),
      ...inbox.tasks.map((t) =>
        el(
          'button',
          { class: 'inbox-row', type: 'button', onclick: () => void jumpTo({ id: t.messageId, room: t.room, threadId: null }) },
          el(
            'span',
            { class: 'inbox-meta' },
            el('strong', { text: `Task #${t.id}` }),
            el('span', { class: 'muted', text: ` → ${t.assignee} · ` }),
            el('span', { class: `chip task-${t.state}`, text: TASK_LABEL[t.state] }),
          ),
          el('span', { class: 'inbox-text', text: snippet(t.request) }),
        ),
      ),
    );
  }
  sections.push(el('h3', { class: 'inbox-heading', text: 'Mentions' }));
  sections.push(
    ...(inbox.mentions.length ? inbox.mentions.map((m) => messageRow(m, { unseen: !m.seen })) : [el('p', { class: 'empty muted', text: 'No one has mentioned you yet.' })]),
  );
  if (!inbox.approvals.length && !inbox.tasks.length) {
    sections.unshift(el('p', { class: 'panel-intro muted small', text: 'Nothing needs your decision right now.' }));
  }
  $('panel-body').replaceChildren(...sections);
}

async function showInbox() {
  openPanel('inbox', 'Inbox');
  const inbox = await api('/inbox');
  if (state.panel !== 'inbox') return;
  renderInbox(inbox);
  const newest = inbox.mentions.find((m) => !m.seen);
  if (newest) {
    await api('/inbox/seen', { method: 'POST', body: { up_to_id: newest.id } });
    void refreshInbox();
  }
}

async function runSearch(query) {
  openPanel('search', `Search: ${query}`);
  let results;
  try {
    results = await api(`/search?q=${encodeURIComponent(query)}`);
  } catch (err) {
    $('panel-body').replaceChildren(el('p', { class: 'empty muted', text: err.message }));
    return;
  }
  if (state.panel !== 'search') return;
  $('panel-body').replaceChildren(
    el('p', {
      class: 'panel-intro muted small',
      text: results.length ? `${results.length}${results.length === 50 ? '+' : ''} ${results.length === 1 ? 'message' : 'messages'}` : 'No messages match.',
    }),
    ...results.map((m) => messageRow(m)),
  );
}

async function jumpTo(target) {
  $('sidebar').classList.remove('open');
  if (target.threadId) {
    if (location.hash.slice(1) !== target.room) location.hash = target.room;
    await openThread({ id: target.threadId, room: target.room });
    flash(`#panel-body [data-id="${target.id}"]`);
    return;
  }
  if (state.room?.ref !== target.room) {
    location.hash = target.room;
    await selectRoom();
  }
  await state.roomLoad;
  for (let page = 0; page < 10 && !state.messages.some((m) => m.id === target.id); page++) {
    if ($('load-older').hidden) break;
    await loadOlder();
  }
  if (window.matchMedia('(max-width: 900px)').matches) closePanel();
  flash(`#message-list [data-id="${target.id}"]`);
}

function flash(selector) {
  const node = document.querySelector(selector);
  if (!node) return;
  node.scrollIntoView({ block: 'center' });
  node.classList.add('flash');
  setTimeout(() => node.classList.remove('flash'), 2000);
}

$('inbox').addEventListener('click', () => {
  $('sidebar').classList.remove('open');
  return state.panel === 'inbox' ? closePanel() : void showInbox();
});
$('search-form').addEventListener('submit', (event) => {
  event.preventDefault();
  const query = $('search-input').value.trim();
  if (query.length >= 2) {
    $('sidebar').classList.remove('open');
    void runSearch(query);
  }
});

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
  void refreshInbox();
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

$('my-agents').addEventListener('click', () => {
  $('sidebar').classList.remove('open');
  return state.panel === 'agents' ? closePanel() : void showMyAgents();
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

wireComposer($('composer'), $('composer-text'), $('composer-pending'), () => state.room.ref, async (text, ids) => {
  if (text.startsWith('/task')) {
    if (ids.length) throw new Error('Tasks cannot carry images yet; post the image, then create the task.');
    const match = TASK_COMMAND.exec(text);
    if (!match) throw new Error('Use /task @agent what you need');
    await api('/tasks', { method: 'POST', body: { agent: match[1], room: state.room.ref, request: match[2] } });
    return null;
  }
  return api('/messages', { method: 'POST', body: { room: state.room.ref, text, attachment_ids: ids } });
});
wireComposer($('thread-composer'), $('thread-text'), $('thread-pending'), () => state.thread.room, (text, ids) =>
  api('/messages', { method: 'POST', body: { room: state.thread.room, text, thread_id: state.thread.id, attachment_ids: ids } }),
);

start().catch((err) => {
  document.body.textContent = `Orco failed to load: ${err.message}`;
});
