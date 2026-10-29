import { attachMentionAutocomplete } from './autocomplete.js';
import { icon } from './icons.js';
import { renderMarkdown } from './markdown.js';
import * as notify from './notify.js';
import { createGuide } from './guide.js';
import { createPortfolio } from './portfolio.js';
import { createTickets } from './tickets.js';

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
  view: 'room',
  loadedRef: null,
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

// Muted, mid-tone colors that keep white initials readable in both themes.
const AVATAR_COLORS = ['#5b63c7', '#3d7f6b', '#a2683a', '#7a5aa8', '#3f77a6', '#a24f6c', '#5f7a3c', '#6b6b78'];

function hue(name) {
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) % 360;
  return h;
}

function avatar(name, kind) {
  const node = el('span', { class: `avatar ${kind === 'agent' ? 'agent' : ''}`, 'aria-hidden': 'true', text: name[0].toUpperCase() });
  node.style.background = AVATAR_COLORS[Math.floor(hue(name) / 45) % AVATAR_COLORS.length];
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
    mention: (name) => {
      const everyone = name === 'all';
      const self = name === state.me.name || (everyone && state.me.kind === 'user');
      return el('span', { class: `mention${self ? ' mention-self' : ''}`, text: `@${name}`, title: everyone ? 'Everyone in this room' : self ? 'You' : name });
    },
    ticket: ticketLink,
  });
}

function ticketLink(key, number) {
  const project = state.projects.find((p) => p.ticketKey === key);
  if (!project) return null;
  const ref = `${key}-${number}`;
  return el('a', {
    class: 'ticket-link',
    href: `#~${project.name}/list`,
    title: `Open ${ref}`,
    text: ref,
    onclick: (event) => {
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
      event.preventDefault();
      $('sidebar').classList.remove('open');
      void tickets.openTicket(ref);
    },
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
  const images = (message.attachments || []).filter((a) => a.mime !== 'text/plain');
  const files = (message.attachments || []).filter((a) => a.mime === 'text/plain');
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
    message.text ? el('div', { class: 'msg-body md' }, richText(message.text)) : null,
    message.external ? externalBlock(message.external) : null,
    images.length
      ? el(
          'div',
          { class: 'images' },
          images.map((image) =>
            el(
              'a',
              { href: `/api/attachments/${image.id}`, target: '_blank', rel: 'noopener', title: image.name },
              el('img', { src: `/api/attachments/${image.id}`, alt: image.name, loading: 'lazy' }),
            ),
          ),
        )
      : null,
    files.length ? el('div', { class: 'files' }, files.map(fileChip)) : null,
    message.task ? taskCard(message) : null,
    message.approval ? approvalCard(message) : null,
    message.question ? questionCard(message) : null,
    message.review ? reviewCard(message) : null,
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

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

const DIFF_NAME = /\.(diff|patch)$/i;
// Terminal colour codes in logs are noise in a browser.
const ANSI = /\u001b\[[0-9;]*[A-Za-z]/g;

/** A text attachment: name and size, opening into the file itself (fetched as text, shown as text). */
function fileChip(file) {
  const body = el('div', { class: 'file-view', hidden: true });
  let loaded = false;
  const toggle = el('button', {
    class: 'ghost small',
    type: 'button',
    text: 'Show',
    'aria-expanded': 'false',
    onclick: async () => {
      const open = body.hidden;
      body.hidden = !open;
      toggle.textContent = open ? 'Hide' : 'Show';
      toggle.setAttribute('aria-expanded', String(open));
      if (!open || loaded) return;
      loaded = true;
      try {
        const res = await fetch(`/api/attachments/${file.id}`, { credentials: 'same-origin' });
        if (!res.ok) throw new Error(res.statusText);
        const text = (await res.text()).replace(ANSI, '');
        const lines = text.split('\n');
        const diff = DIFF_NAME.test(file.name);
        body.replaceChildren(
          el(
            'pre',
            {},
            lines.map((line, i) =>
              el('span', {
                class: diff ? (line.startsWith('+') && !line.startsWith('+++') ? 'add' : line.startsWith('-') && !line.startsWith('---') ? 'del' : line.startsWith('@@') ? 'hunk' : '') : '',
                text: `${line}${i < lines.length - 1 ? '\n' : ''}`,
              }),
            ),
          ),
        );
      } catch (err) {
        body.replaceChildren(el('p', { class: 'muted small', text: `Could not load the file: ${err.message}` }));
      }
    },
  });
  return el(
    'div',
    { class: 'file-chip' },
    el(
      'div',
      { class: 'file-head' },
      icon('file'),
      el('span', { class: 'file-name', text: file.name }),
      el('span', { class: 'muted small', text: formatBytes(file.size) }),
      toggle,
      el('a', { class: 'ghost small button-link', href: `/api/attachments/${file.id}`, download: file.name, text: 'Download' }),
    ),
    body,
  );
}

/** Text the author relayed from outside Orco: shown apart from their own words, never as markdown, never with live links. */
function externalBlock(external) {
  return el(
    'figure',
    { class: 'external-block' },
    el('figcaption', {}, el('span', { class: 'chip external-chip', text: 'External' }), el('span', { class: 'muted small', text: `from ${external.source} · untrusted, relayed by the author` })),
    el('blockquote', { text: external.text }),
  );
}

function money(cents) {
  return `$${(cents / 100).toFixed(2)}`;
}

function budgetLine(budget) {
  const parts = [];
  const started = budget.elapsedMinutes !== null;
  if (budget.minutes !== null) parts.push(started ? `${budget.elapsedMinutes} of ${budget.minutes} min` : `${budget.minutes} min budget`);
  else if (started) parts.push(`${budget.elapsedMinutes} min`);
  if (budget.cents !== null) parts.push(started || budget.spentCents ? `${money(budget.spentCents)} of ${money(budget.cents)}` : `${money(budget.cents)} budget`);
  else if (budget.spentCents) parts.push(money(budget.spentCents));
  if (budget.tokens) parts.push(`${budget.tokens.toLocaleString()} tokens`);
  return el('span', { class: `chip budget${budget.over ? ' over' : ''}`, title: budget.over ? 'Over budget: the agent was asked to stop and check with the requester' : 'Budget and spend so far', text: `${budget.over ? 'Over budget · ' : ''}${parts.join(' · ')}` });
}

async function rateTask(id, rating) {
  let note = '';
  if (rating === 'down') {
    note = prompt('What should the agent do differently next time? (it reads this)');
    if (note === null) return;
  }
  try {
    await api(`/tasks/${id}/feedback`, { method: 'POST', body: { rating, note } });
  } catch (err) {
    alert(err.message);
  }
}

async function decideSuggestion(id, action) {
  try {
    if (action === 'accept') {
      const result = await api(`/suggestions/${id}/accept`, { method: 'POST', body: {} });
      void tickets.openTicket(result.ticket.ref);
    } else {
      await api(`/suggestions/${id}/dismiss`, { method: 'POST', body: {} });
    }
    scheduleInbox();
  } catch (err) {
    alert(err.message);
  }
}

function followupList(followups) {
  return el(
    'ul',
    { class: 'followups' },
    followups.map((f) =>
      el(
        'li',
        { class: `followup followup-${f.state}` },
        el('span', { class: 'muted small', text: 'Follow-up' }),
        f.ticket ? ticketLink(...f.ticket.split(/-(?=\d+$)/)) ?? el('span', { text: f.ticket }) : null,
        el('span', { class: 'followup-title', text: f.title }),
        f.state === 'open' && state.me.kind === 'user'
          ? [
              el('button', { class: 'small', type: 'button', text: 'File ticket', onclick: () => void decideSuggestion(f.id, 'accept') }),
              el('button', { class: 'ghost small', type: 'button', text: 'Dismiss', onclick: () => void decideSuggestion(f.id, 'dismiss') }),
            ]
          : f.state === 'dismissed'
            ? el('span', { class: 'muted small', text: 'dismissed' })
            : null,
      ),
    ),
  );
}

const REVIEW_LABEL = { pending: 'Waiting for review', approved: 'Approved', changes_requested: 'Changes requested', withdrawn: 'Withdrawn' };

async function submitReview(id, verdict) {
  let note;
  if (verdict === 'changes_requested') {
    note = prompt('What needs to change? (shared with the author)');
    if (!note) return;
  }
  try {
    await api(`/reviews/${id}`, { method: 'POST', body: { verdict, note } });
    scheduleInbox();
  } catch (err) {
    alert(err.message);
  }
}

function reviewButtons(id) {
  return [
    el('button', { class: 'ghost small danger', type: 'button', text: 'Request changes', onclick: () => void submitReview(id, 'changes_requested') }),
    el('button', { class: 'primary small', type: 'button', text: 'Approve', onclick: () => void submitReview(id, 'approved') }),
  ];
}

function reviewCard(message) {
  const r = message.review;
  const mine = r.state === 'pending' && r.reviewer === state.me.name;
  return el(
    'div',
    { class: `review-card review-${r.state}` },
    el(
      'div',
      { class: 'question-head' },
      el('span', { class: 'task-id', text: `Review of ${r.target}` }),
      el('span', { class: 'chip', text: REVIEW_LABEL[r.state] }),
      el('span', { class: 'muted small', text: r.state === 'pending' ? `by ${r.reviewer}` : `${r.reviewer}` }),
      mine ? el('span', { class: 'spacer' }) : null,
      mine ? reviewButtons(r.id) : null,
    ),
    r.note ? el('div', { class: 'question-answer', text: r.note }) : null,
  );
}

function onReview(review) {
  let touched = false;
  for (const list of [state.messages, state.threadMessages]) {
    for (const message of list) {
      if (message.review && message.review.id === review.id) {
        touched = true;
        void api(`/reviews/${review.id}`).then((full) => {
          message.review = { ...message.review, state: full.state, note: full.note };
          renderMessages({ keepScroll: true });
          if (state.panel === 'thread') renderThread({ keepScroll: true });
        }, () => {});
      } else if (message.id === review.messageId && !message.review) {
        touched = true;
        void api(`/reviews/${review.id}`).then((full) => {
          const { room, messageId, projectId, createdAt, decidedAt, ...summary } = full;
          message.review = summary;
          renderMessages({ keepScroll: true });
        }, () => {});
      }
    }
  }
  scheduleInbox();
  return touched;
}

const TASK_LABEL = {
  awaiting_approval: 'Waiting for owner',
  requested: 'Requested',
  accepted: 'In progress',
  needs_input: 'Needs input',
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
  const { id, state: taskState, assignee, since, chain = [], progress = null, stalled = false, seenAt = null, budget = null, links = [], followups = [], feedback = { up: 0, down: 0 } } = message.task;
  const open = ['awaiting_approval', 'requested', 'accepted', 'needs_input'].includes(taskState);
  const mine = message.author === state.me.name || message.owner === state.me.name;
  const extras = [
    budget ? budgetLine(budget) : null,
    links.length
      ? el(
          'span',
          { class: 'task-links' },
          links.map((link) => el('a', { href: link.url, target: '_blank', rel: 'noopener noreferrer nofollow', title: link.url, text: link.title || new URL(link.url).host + new URL(link.url).pathname })),
        )
      : null,
  ].filter(Boolean);
  const card = el(
    'div',
    { class: `task-card task-${taskState}` },
    el('span', { class: 'task-id', text: `Task #${id}` }),
    el('span', { class: 'muted', text: `→ ${assignee}` }),
    chain.length > 1 ? el('span', { class: 'muted small', title: chain.join(' → '), text: `from ${chain[0]} via ${chain.slice(1).join(', ')}` }) : null,
    stalled
      ? el('span', { class: 'chip stalled', title: `No sign of life from ${assignee} for a while; it may have crashed`, text: 'Stalled' })
      : el(
          'span',
          { class: 'chip' },
          taskState === 'accepted' ? el('span', { class: 'working-dot', 'aria-hidden': 'true' }) : null,
          taskState === 'accepted' && since ? liveElapsed('In progress · ', since) : TASK_LABEL[taskState],
        ),
    taskState === 'requested'
      ? el('span', { class: 'muted small seen', title: seenAt ? new Date(seenAt).toLocaleString() : `${assignee} has not looked at it yet` }, seenAt ? liveElapsed('Seen ', seenAt) : 'Not seen yet')
      : null,
    progress && open
      ? el('span', { class: 'task-progress', title: `Updated ${formatTime(progress.at)}` }, progress.percent !== null ? progressMeter(progress.percent) : null, progress.text)
      : null,
    extras,
    (taskState === 'done' || taskState === 'failed') && state.me.kind === 'user'
      ? el(
          'span',
          { class: 'task-feedback', role: 'group', 'aria-label': 'Rate the result' },
          el('button', { class: 'ghost small', type: 'button', title: 'Good result', text: `▲ ${feedback.up || ''}`.trim(), onclick: () => void rateTask(id, 'up') }),
          el('button', { class: 'ghost small', type: 'button', title: 'Not good: tell the agent why', text: `▼ ${feedback.down || ''}`.trim(), onclick: () => void rateTask(id, 'down') }),
        )
      : null,
    state.me.kind === 'user'
      ? el('button', { class: 'ghost small', type: 'button', text: 'Trail', title: 'What the agent did on this task', onclick: () => void showTrail(id) })
      : null,
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
  return followups.length ? el('div', { class: 'task-wrap' }, card, followupList(followups)) : card;
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

const QUESTION_LABEL = { open: 'Waiting for an answer', answered: 'Answered', resumed: 'Answered', cancelled: 'Closed' };

function answerBox(questionId, onDone) {
  const input = el('input', { class: 'answer-input', placeholder: 'Your answer', 'aria-label': 'Answer', maxlength: '4000' });
  const send = async () => {
    if (!input.value.trim()) return;
    try {
      await api(`/questions/${questionId}/answer`, { method: 'POST', body: { answer: input.value } });
      onDone?.();
    } catch (err) {
      alert(err.message);
    }
  };
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      void send();
    }
  });
  return el('div', { class: 'answer-box' }, input, el('button', { class: 'primary small', type: 'button', text: 'Answer', onclick: () => void send() }));
}

function progressMeter(percent) {
  const fill = el('span', { class: 'meter-fill' });
  fill.style.width = `${percent}%`;
  return el('span', { class: 'meter', title: `${percent}%`, 'aria-label': `${percent}%` }, fill);
}

function planBox(questionId, plan, onDone) {
  const area = el('textarea', { rows: String(Math.min(12, plan.split('\n').length + 1)), 'aria-label': 'Plan', class: 'plan-edit-area' });
  area.value = plan;
  const note = el('input', { placeholder: 'Note or reason (optional)', 'aria-label': 'Note', maxlength: '500' });
  const decide = async (approve) => {
    if (!approve && !note.value.trim() && !confirm('Reject without a reason?')) return;
    try {
      await api(`/questions/${questionId}/decide`, { method: 'POST', body: { approve, plan: approve ? area.value : undefined, note: note.value || undefined } });
      onDone?.();
    } catch (err) {
      alert(err.message);
    }
  };
  return el(
    'div',
    { class: 'plan-box' },
    area,
    note,
    el(
      'div',
      { class: 'row-end' },
      el('button', { class: 'ghost small danger', type: 'button', text: 'Reject', onclick: () => void decide(false) }),
      el('button', { class: 'primary small', type: 'button', text: 'Approve', onclick: () => void decide(true) }),
    ),
  );
}

const PLAN_LABEL = { open: 'Waiting for approval', cancelled: 'Closed' };

function planCard(message) {
  const q = message.question;
  const canDecidePlan = q.state === 'open' && state.me.kind === 'user' && (q.target === state.me.name || message.owner === state.me.name);
  const label = q.verdict === 'approved' ? 'Approved' : q.verdict === 'rejected' ? 'Rejected' : PLAN_LABEL[q.state] ?? 'Answered';
  const final = q.verdict === 'approved' ? (q.answer ?? '').split('Final plan:\n')[1] ?? '' : '';
  return el(
    'div',
    { class: `question-card plan-card-msg question-${q.state} verdict-${q.verdict ?? 'none'}` },
    el(
      'div',
      { class: 'question-head' },
      el('span', { class: 'task-id', text: `Plan for ${q.target}` }),
      el('span', { class: 'chip', text: label }),
      q.answeredBy ? el('span', { class: 'muted small', text: `by ${q.answeredBy}` }) : null,
    ),
    canDecidePlan ? planBox(q.id, q.question) : null,
    final && final !== q.question ? el('div', { class: 'md question-answer' }, el('p', { class: 'muted small', text: 'Final plan, as approved:' }), richText(final)) : null,
    q.verdict === 'rejected' ? el('div', { class: 'question-answer', text: q.answer }) : null,
  );
}

function questionCard(message) {
  const q = message.question;
  if (q.kind === 'plan') return planCard(message);
  const everyone = q.audience === 'project';
  const canAnswer =
    q.state === 'open' && ((everyone && state.me.kind === 'user') || q.target === state.me.name || message.owner === state.me.name);
  const project = message.room.includes('/') ? message.room.split('/')[0] : null;
  return el(
    'div',
    { class: `question-card question-${q.state}` },
    el(
      'div',
      { class: 'question-head' },
      el('span', { class: 'task-id', text: everyone ? `Question for everyone${project ? ` in ${project}` : ''}` : `Question for ${q.target}` }),
      el('span', { class: 'chip', text: QUESTION_LABEL[q.state] }),
      q.answeredBy ? el('span', { class: 'muted small', text: `by ${q.answeredBy}` }) : null,
      q.state === 'open' ? el('span', { class: 'muted small seen' }, q.seenAt ? liveElapsed('Seen ', q.seenAt) : 'Not seen yet') : null,
    ),
    q.answer ? el('div', { class: 'question-answer', text: q.answer }) : null,
    canAnswer ? answerBox(q.id) : null,
  );
}

function onQuestion(question) {
  let touched = false;
  for (const list of [state.messages, state.threadMessages]) {
    for (const message of list) {
      if (message.question && message.question.id === question.id) {
        message.question = { ...message.question, state: question.state, answer: question.answer, answeredBy: question.answeredBy, verdict: question.verdict, seenAt: question.seenAt };
        touched = true;
      }
    }
  }
  scheduleInbox();
  if (!touched) return;
  renderMessages({ keepScroll: true });
  if (state.panel === 'thread') renderThread({ keepScroll: true });
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
    $('panel-body').replaceChildren(
      agentActions(),
      el('p', { class: 'panel-intro muted small', text: 'You have no agents yet. An agent is an AI helper you own, like Claude Code or Codex, that works on tasks you and others give it.' }),
    );
    return;
  }
  $('panel-body').replaceChildren(
    agentActions(),
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
      const spend = agent.spend30d;
      const memory = el('div', { class: 'agent-memory' });
      const showMemory = async () => {
        const notes = await api(`/agents/${encodeURIComponent(agent.name)}/memory`);
        memory.replaceChildren(
          notes.length
            ? el(
                'ul',
                { class: 'memory-list' },
                notes.map((n) =>
                  el(
                    'li',
                    {},
                    el('div', { class: 'memory-head' }, el('strong', { text: n.title }), el('span', { class: 'muted small', text: formatTime(n.updatedAt) }), el('span', { class: 'spacer' }),
                      el('button', {
                        class: 'ghost small danger',
                        type: 'button',
                        text: 'Forget',
                        onclick: async () => {
                          if (!confirm(`Delete ${agent.name}'s note “${n.title}”?`)) return;
                          await api(`/agents/${encodeURIComponent(agent.name)}/memory/${n.id}`, { method: 'DELETE' });
                          void showMemory();
                        },
                      }),
                    ),
                    el('div', { class: 'memory-body', text: n.body }),
                  ),
                ),
              )
            : el('p', { class: 'muted small', text: 'No notes yet.' }),
        );
      };
      return el(
        'section',
        { class: 'agent-settings' },
        el(
          'div',
          { class: 'agent-name' },
          avatar(agent.name, 'agent'),
          el('strong', { text: agent.name }),
          el('span', { class: 'spacer' }),
          el('button', { class: 'ghost small', type: 'button', text: 'Connect…', title: `Ways to connect ${agent.name}`, onclick: () => guide.showConnect(agent.name) }),
          el('button', {
            class: 'ghost small',
            type: 'button',
            text: 'New token',
            title: 'Make a new token; the old one stops working',
            onclick: async () => {
              if (!confirm(`Make a new token for ${agent.name}? Anything using the old one (a bridge, a Claude Code setup) stops working until you give it the new one.`)) return;
              try {
                const made = await api(`/agents/${encodeURIComponent(agent.name)}/token`, { method: 'POST', body: {} });
                guide.showConnect(agent.name, made.token);
              } catch (err) {
                alert(err.message);
              }
            },
          }),
        ),
        scorecard(agent.scorecard30d, spend),
        el(
          'details',
          { class: 'memory-details', ontoggle: (event) => event.target.open && void showMemory() },
          el('summary', { class: 'small', text: `Private notes (${agent.memory ?? 0})` }),
          el('p', { class: 'small muted', text: `What ${agent.name} keeps between sessions. Only it and you can see these.` }),
          memory,
        ),
        connections.length
          ? el('div', { class: 'trusted' }, el('span', { class: 'small muted', text: 'Connected apps:' }), el('ul', { class: 'connections' }, connections))
          : null,
        el('label', { class: 'small', text: 'Who may give it tasks' }),
        select,
        el(
          'label',
          { class: 'check small', title: 'Otherwise its suggestions wait in your Inbox for you to file or dismiss' },
          el('input', {
            type: 'checkbox',
            checked: agent.autoFileFollowups,
            onchange: async (event) => {
              try {
                await api(`/agents/${encodeURIComponent(agent.name)}/followups`, { method: 'POST', body: { auto: event.target.checked } });
              } catch (err) {
                alert(err.message);
              }
              void showMyAgents();
            },
          }),
          'File the follow-ups it suggests as tickets without asking me',
        ),
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

function agentActions() {
  return el(
    'div',
    { class: 'panel-actions' },
    el('button', { class: 'primary small', type: 'button', text: 'Add an agent', onclick: () => guide.addAgent() }),
    el('button', { class: 'small', type: 'button', text: 'Connect a computer', onclick: () => guide.connectComputer() }),
  );
}

function onTask(task) {
  let touched = false;
  for (const list of [state.messages, state.threadMessages]) {
    for (const message of list) {
      if (message.task && message.task.id === task.id) {
        message.task = {
          id: task.id,
          state: task.state,
          assignee: task.assignee,
          since: task.updatedAt,
          chain: task.chain,
          progress: task.progress,
          stalled: task.stalled,
          seenAt: task.seenAt,
          budget: task.budget,
          links: task.links,
          followups: task.followups,
          feedback: task.feedback,
        };
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
      'aria-current': state.view === 'room' && state.room?.ref === room.ref ? 'page' : null,
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
        el(
          'a',
          {
            class: 'room-link tickets-link',
            href: `#~${project.name}`,
            'aria-current': state.view === 'tickets' && tickets.project === project.name ? 'page' : null,
            onclick: () => $('sidebar').classList.remove('open'),
          },
          icon('task'),
          el('span', { text: 'Tickets' }),
        ),
        rooms.map(roomLink),
      ),
    );
  }
}

async function loadStructure() {
  [state.projects, state.rooms] = await Promise.all([api('/projects'), api('/rooms')]);
  renderNav();
  void guide.refreshSteps();
}

/* Rooms */

function roomFromHash() {
  const ref = decodeURIComponent(location.hash.slice(1));
  return state.rooms.find((r) => r.ref === ref) || state.rooms.find((r) => r.ref === 'lobby') || state.rooms[0];
}

function renderRoomTitle() {
  const title = $('room-title');
  title.replaceChildren();
  if (state.view === 'portfolio') {
    title.append('Portfolio');
    for (const id of ['add-member', 'show-locks', 'audit-log', 'show-members']) $(id).hidden = true;
    document.title = 'Portfolio · Orco';
    return;
  }
  $('show-members').hidden = false;
  if (state.view === 'tickets') {
    title.append(el('span', { class: 'project', text: `${tickets.project} / ` }), 'Tickets');
    document.title = `${tickets.project} tickets · Orco`;
    return;
  }
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

function ticketsRoute() {
  const match = /^#~([a-z0-9][a-z0-9-]{0,31})(?:\/([a-z]+))?$/.exec(location.hash);
  return match && state.projects.some((p) => p.name === match[1]) ? { project: match[1], tab: match[2] || 'board' } : null;
}

function setView(view) {
  state.view = view;
  for (const id of ['messages', 'composer', 'composer-pending', 'ask-agent']) $(id).hidden = view !== 'room';
  $('tickets-view').hidden = view !== 'tickets';
  $('portfolio-view').hidden = view !== 'portfolio';
  $('portfolio').classList.toggle('active', view === 'portfolio');
}

function portfolioRoute() {
  const match = /^#!portfolio(?:\/([a-z]+))?$/.exec(location.hash);
  return match ? { tab: match[1] || 'overview' } : null;
}

/** Links that open a dialog or panel over whatever is showing, then put the address back. */
function overlayRoute() {
  const pair = /^#pair=([A-Za-z0-9-]{4,12})$/.exec(location.hash);
  if (pair) void guide.openPairCode(pair[1]);
  else if (location.hash === '#!help') guide.showHelp();
  else return false;
  history.replaceState(null, '', state.viewHash || location.pathname + location.search);
  return Boolean(state.room);
}

async function selectRoom() {
  if (overlayRoute()) return;
  state.viewHash = location.hash || undefined;
  const across = portfolioRoute();
  if (across) {
    setView('portfolio');
    renderNav();
    renderRoomTitle();
    if (state.panel === 'thread' || state.panel === 'locks' || state.panel === 'members') closePanel();
    await portfolio.show(across.tab);
    return;
  }
  const route = ticketsRoute();
  if (route) {
    setView('tickets');
    state.room = state.rooms.find((r) => r.project === route.project && r.name === 'general') || state.rooms.find((r) => r.project === route.project);
    state.loadedRef = null;
    const showing = tickets.show(route.project, route.tab);
    renderNav();
    renderRoomTitle();
    if (state.panel === 'thread' || state.panel === 'locks') closePanel();
    else if (state.panel === 'members') void showMembers();
    await showing;
    return;
  }
  const room = roomFromHash();
  if (!room) return;
  setView('room');
  const changed = state.loadedRef !== room.ref;
  state.loadedRef = room.ref;
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
  $('panel').classList.toggle('wide', kind === 'ticket' || kind === 'new-ticket');
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

function summaryBox() {
  const summary = state.threadSummary;
  const wrap = el('section', { class: 'thread-summary' });
  const view = () => {
    wrap.replaceChildren(
      el(
        'div',
        { class: 'section-head' },
        el('h3', { text: 'Summary' }),
        summary ? el('span', { class: 'muted small section-meta', text: `${summary.updatedBy} · ${formatTime(summary.updatedAt)}` }) : null,
        el('span', { class: 'spacer' }),
        el('button', { class: 'ghost small', type: 'button', text: summary ? 'Edit' : 'Add', onclick: edit }),
      ),
      summary ? el('div', { class: 'md ticket-text' }, richText(summary.text)) : el('p', { class: 'muted small', text: 'No summary yet. Decisions, open questions and where things stand.' }),
    );
  };
  const edit = () => {
    const area = el('textarea', { rows: '4', 'aria-label': 'Thread summary' });
    area.value = summary?.text ?? '';
    wrap.replaceChildren(
      area,
      el(
        'div',
        { class: 'row-end' },
        el('button', { class: 'ghost small', type: 'button', text: 'Cancel', onclick: view }),
        el('button', {
          class: 'primary small',
          type: 'button',
          text: 'Save',
          onclick: async () => {
            try {
              state.threadSummary = await api(`/threads/${state.thread.id}/summary`, { method: 'POST', body: { room: state.thread.room, summary: area.value } });
              renderThread({ keepScroll: true });
            } catch (err) {
              alert(err.message);
            }
          },
        }),
      ),
    );
    area.focus();
  };
  view();
  return wrap;
}

async function loadThreadSummary() {
  const thread = state.thread;
  if (!thread) return;
  const summary = await api(`/threads/${thread.id}/summary?room=${encodeURIComponent(thread.room)}`).catch(() => null);
  if (state.thread !== thread) return;
  state.threadSummary = summary;
  if (state.panel === 'thread') renderThread({ keepScroll: true });
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
  body.replaceChildren(summaryBox(), list);
  body.scrollTop = keepScroll ? top : body.scrollHeight;
}

function trailLine(entry) {
  const d = entry.detail ?? {};
  switch (entry.action) {
    case 'message.post':
      return `posted in ${d.room}: ${snippet(d.text ?? '', 140)}`;
    case 'task.update':
      return `${entry.subject.replace('task:', 'task #')} → ${d.state}${d.note ? `: ${snippet(d.note, 120)}` : ''}`;
    case 'task.progress':
      return `progress: ${d.text}${d.percent !== null && d.percent !== undefined ? ` (${d.percent}%)` : ''}`;
    case 'task.create':
      return `${entry.subject.replace('task:', 'task #')} created for ${d.assignee}: ${snippet(d.request ?? '', 120)}`;
    case 'ticket.update':
      return `${entry.subject.replace('ticket:', '')}: changed ${(d.changes ?? []).map((c) => c.field).join(', ')}`;
    case 'question.ask':
    case 'plan.propose':
      return `${entry.action === 'plan.propose' ? 'proposed a plan' : 'asked'}: ${snippet(d.question ?? '', 140)}`;
    case 'ticket.comment':
      return `commented on ${entry.subject.replace('ticket:', '')}: ${snippet(d.text ?? '', 120)}`;
    case 'ticket.create':
      return `filed ${entry.subject.replace('ticket:', '')}: ${d.title}`;
    case 'note.create':
    case 'note.update':
      return `saved the project note “${d.title}”`;
    case 'note.delete':
      return `deleted the project note “${d.title}”`;
    case 'lock.acquire':
      return `took the lock ${entry.subject?.replace(/^lock:/, '') ?? ''}`;
    case 'lock.release':
      return `released the lock ${entry.subject?.replace(/^lock:/, '') ?? ''}`;
    case 'agent.profile':
      return 'updated its profile';
    case 'task.run':
      return `ran ${d.mode === 'start' ? '' : `(${d.mode}) `}for ${duration(d.seconds ?? 0)}: ${d.outcome}${d.costMicros ? ` · ${dollars(d.costMicros)}` : ''}`;
    case 'task.feedback':
      return `rated the result ${d.rating === 'up' ? '▲' : '▼'}${d.note ? `: ${snippet(d.note, 120)}` : ''}`;
    case 'thread.summary':
      return 'updated a thread summary';
    case 'flag.create':
      return `flagged something to its owner: ${snippet(d.reason ?? '', 120)}`;
    case 'question.answer':
    case 'plan.approve':
    case 'plan.reject':
      return `${entry.action === 'question.answer' ? 'answered' : entry.action === 'plan.approve' ? 'approved the plan' : 'rejected the plan'}: ${snippet(d.answer ?? '', 120)}`;
    case 'approval.request':
      return `asked for approval: ${snippet(d.summary ?? '', 120)}`;
    default:
      return `${entry.action}${entry.subject ? ` ${entry.subject}` : ''}`;
  }
}

function duration(seconds) {
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return minutes < 60 ? `${minutes}m ${seconds % 60}s` : `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

function compact(n) {
  return n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(n);
}

function dollars(micros) {
  return `$${(micros / 1e6).toFixed(micros < 10_000 ? 4 : 2)}`;
}

/** The bridge's reports on each run of the agent: time, outcome, usage, branch, and the log. */
function runList(runs) {
  if (!runs.length) return null;
  return el(
    'section',
    { class: 'runs' },
    el('h3', { class: 'small', text: `Runs (${runs.length})` }),
    el(
      'ol',
      { class: 'run-list' },
      runs.map((run, i) => {
        const tokens = (run.inputTokens ?? 0) + (run.outputTokens ?? 0);
        const log = el('pre', { class: 'run-log', hidden: true });
        const facts = [
          run.mode === 'start' ? null : run.mode === 'resume' ? 'resumed' : 'reminder',
          duration(run.seconds),
          run.outcome,
          tokens ? `${compact(tokens)} tokens` : null,
          run.costMicros !== null ? dollars(run.costMicros) : null,
        ].filter(Boolean);
        return el(
          'li',
          {},
          el(
            'div',
            { class: 'run-head' },
            el('strong', { text: `#${i + 1}` }),
            el('span', { class: 'muted small', text: formatTime(run.startedAt) }),
            el('span', { class: 'small', text: facts.join(' · ') }),
            run.branch ? el('code', { class: 'small', title: run.workspace ?? '', text: run.branch }) : null,
            run.logBytes
              ? el('button', {
                  class: 'ghost small',
                  type: 'button',
                  text: 'Log',
                  title: `${compact(run.logBytes)} bytes${run.logCut ? ', middle cut' : ''}; secrets the bridge knew of are hidden`,
                  onclick: async () => {
                    if (!log.hidden) {
                      log.hidden = true;
                      return;
                    }
                    try {
                      // Agent output is untrusted: shown as plain text only.
                      log.textContent = (await api(`/runs/${run.id}/log?format=json`)).log;
                    } catch (err) {
                      log.textContent = err.message;
                    }
                    log.hidden = false;
                  },
                })
              : el('span', { class: 'muted small', text: 'no log' }),
          ),
          log,
        );
      }),
    ),
  );
}

/** How an agent did over the last 30 days, from its tasks, the bridge's run reports and people's feedback. */
function scorecard(card, spend) {
  if (!card || !card.tasks.total) return null;
  const { done, failed, open } = card.tasks;
  const cents = spend?.cents ?? 0;
  const parts = [
    `${done} done`,
    failed ? `${failed} failed` : null,
    card.successRate !== null ? `${Math.round(card.successRate * 100)}% success` : null,
    open ? `${open} open` : null,
    card.medianMinutes !== null ? `median ${card.medianMinutes < 60 ? `${Math.round(card.medianMinutes)} min` : `${Math.round(card.medianMinutes / 6) / 10} h`}` : null,
    card.askedForHelp ? `asked for help on ${card.askedForHelp}` : null,
    cents ? `${money(cents)}${done ? ` (${money(Math.round(cents / done))} per done task)` : ''}` : null,
    card.tokens.input + card.tokens.output ? `${compact(card.tokens.input + card.tokens.output)} tokens` : null,
    card.feedback.up || card.feedback.down ? `▲ ${card.feedback.up} ▼ ${card.feedback.down}` : null,
  ].filter(Boolean);
  return el(
    'p',
    { class: 'small muted agent-spend', title: 'Tasks from the last 30 days. Cost and tokens come from the bridge and from what the agent reported.' },
    el('strong', { text: 'Last 30 days: ' }),
    parts.join(' · '),
  );
}

async function showTrail(taskId) {
  openPanel('trail', `Task #${taskId} trail`);
  $('panel-body').replaceChildren(el('p', { class: 'panel-intro muted small', text: 'Loading…' }));
  let entries;
  let runs;
  try {
    [entries, runs] = await Promise.all([api(`/tasks/${taskId}/trail`), api(`/tasks/${taskId}/runs`)]);
  } catch (err) {
    $('panel-body').replaceChildren(el('p', { class: 'panel-intro error', text: err.message }));
    return;
  }
  if (state.panel !== 'trail') return;
  $('panel-body').replaceChildren(
    el('p', { class: 'panel-intro muted small', text: 'Everything recorded about this task, and what its agent did while it was open. Work for other tasks in the same window shows too.' }),
    runList(runs),
    el(
      'ol',
      { class: 'trail' },
      entries.map((e) =>
        el(
          'li',
          {},
          el('span', { class: 'trail-time muted small', text: formatTime(e.at) }),
          el('span', {}, el('strong', { text: e.actor ?? 'Orco' }), ` ${trailLine(e)}`),
        ),
      ),
    ),
  );
}

async function openThread(message) {
  state.thread = message;
  openPanel('thread', 'Thread');
  state.threadSummary = null;
  state.threadMessages = await api(`/messages?room=${encodeURIComponent(message.room)}&thread_id=${message.id}&limit=200`);
  renderThread();
  void loadThreadSummary();
  $('thread-text').focus();
}

const STATUS_TEXT = { online: 'Online', listening: 'Listening for mentions', standby: 'Standby · wakes on tasks', offline: 'Offline' };

async function showMembers() {
  openPanel('members', 'Members');
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
      el(
        'div',
        { class: 'member-info' },
        el('span', { text: p.name }),
        el('span', { class: 'sub', text: sub }),
        p.profile?.skills.length ? el('span', { class: 'sub skills', title: p.profile.environment || null, text: p.profile.skills.join(' · ') }) : null,
        working,
      ),
    );
  };
  const humans = sorted('user');
  const agents = sorted('agent');
  const project = state.room.project;
  const manage = project && (state.me.orgAdmin || state.projects.find((pr) => pr.name === project)?.role === 'admin');
  $('panel-body').replaceChildren(
    el('div', { class: 'member-group' }, 'People', el('span', { text: String(humans.length) })),
    ...humans.map(row),
    el('div', { class: 'member-group' }, 'Agents', el('span', { text: String(agents.length) })),
    ...agents.map(row),
    manage ? await accessSection(project) : null,
  );
}

const ROLE_TEXT = { admin: 'Admin: manages members and settings', member: 'Member', viewer: 'Viewer: reads only' };

/** For project admins: each person's role, and the groups in the project. */
async function accessSection(project) {
  const p = encodeURIComponent(project);
  const [access, groups] = await Promise.all([api(`/projects/${p}/access`), api('/groups')]);
  const change = (fn) => async () => {
    try {
      await fn();
      void showMembers();
    } catch (err) {
      alert(err.message);
    }
  };
  const roleSelect = (value, onchange, allowNone = false) =>
    el(
      'select',
      { class: 'small', onchange: (event) => void change(() => onchange(event.target.value))() },
      ['admin', 'member', 'viewer'].map((r) => el('option', { value: r, text: ROLE_TEXT[r], selected: r === value ? true : null })),
      allowNone ? el('option', { value: '', text: 'Remove from project' }) : null,
    );
  const unused = groups.filter((g) => !access.groups.some((x) => x.name === g.name));
  const groupPick = el('select', { class: 'small', 'aria-label': 'Group to add' }, unused.map((g) => el('option', { value: g.name, text: `@${g.name} (${g.members.length})` })));
  return el(
    'section',
    { class: 'access' },
    el('div', { class: 'member-group' }, 'Access', el('span', { text: project })),
    ...access.members.map((m) =>
      el(
        'div',
        { class: 'access-row' },
        el('span', { text: m.name }),
        roleSelect(m.role, (role) =>
          role
            ? api(`/projects/${p}/members`, { method: 'POST', body: { user: m.name, role } })
            : api(`/projects/${p}/members/${encodeURIComponent(m.name)}`, { method: 'DELETE' }),
          true,
        ),
      ),
    ),
    ...access.groups.map((g) =>
      el(
        'div',
        { class: 'access-row' },
        el('span', { title: g.members.join(', '), text: `@${g.name}` }),
        roleSelect(g.role, (role) => api(`/projects/${p}/groups`, { method: 'POST', body: { group: g.name, role: role || null } }), true),
      ),
    ),
    unused.length
      ? el(
          'div',
          { class: 'access-row' },
          groupPick,
          el('button', { class: 'ghost small', type: 'button', text: 'Add group', onclick: change(() => api(`/projects/${p}/groups`, { method: 'POST', body: { group: groupPick.value, role: 'member' } })) }),
        )
      : null,
  );
}

/* Live updates */

const seen = new Set();

function onMessage(message) {
  if (seen.has(message.id)) return;
  seen.add(message.id);
  if (message.mentions.includes(state.me.name)) {
    scheduleInbox();
    if (message.author !== state.me.name) {
      void notify.show(
        {
          title: message.question ? `${message.author} asks you` : `${message.author} in #${message.room}`,
          body: message.text,
          tag: `message-${message.id}`,
          hash: `#${message.room}`,
          target: { id: message.id, room: message.room, threadId: message.threadId },
        },
        openFromNotification,
      );
    }
  }
  const here = state.view === 'room' && state.room && message.room === state.room.ref;
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
    if (!$('getting-started').hidden) void guide.refreshSteps();
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
  for (const name of ['controls', 'decision', 'pause', 'task', 'approval']) events.addEventListener(name, () => portfolio.onEvent());
  events.addEventListener('ticket', (event) => {
    portfolio.onEvent();
    tickets.onEvent(JSON.parse(event.data));
    if (state.panel === 'inbox') scheduleInbox();
  });
  events.addEventListener('question', (event) => onQuestion(JSON.parse(event.data)));
  events.addEventListener('review', (event) => onReview(JSON.parse(event.data)));
  events.addEventListener('suggestion', () => scheduleInbox());
  events.addEventListener('schedule', (event) => tickets.onSchedules(JSON.parse(event.data)));
  events.addEventListener('files', (event) => tickets.onFiles(JSON.parse(event.data)));
  events.addEventListener('flag', () => scheduleInbox());
  events.addEventListener('notes', (event) => tickets.onNotes(JSON.parse(event.data)));
  events.addEventListener('summary', (event) => {
    const { threadId } = JSON.parse(event.data);
    if (state.panel === 'thread' && state.thread?.id === threadId) void loadThreadSummary();
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
const MAX_TEXT_BYTES = 1024 * 1024;
const MAX_IMAGES = 4;
const TEXT_NAME = /\.(txt|log|md|diff|patch|json|csv|tsv|ya?ml|toml|ini|conf|cfg|env\.example|sql|py|rb|go|rs|java|kt|c|h|cpp|cs|ts|tsx|jsx|css|scss|sh|ps1|xml)$/i;

function isTextFile(file) {
  return (file.type.startsWith('text/') && file.type !== 'text/html') || file.type === 'application/json' || TEXT_NAME.test(file.name || '');
}

async function uploadImage(file, room) {
  const res = await fetch(`/api/attachments?room=${encodeURIComponent(room)}&name=${encodeURIComponent(file.name || 'file')}`, {
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
          item.url ? el('img', { src: item.url, alt: item.file.name || 'image' }) : el('span', { class: 'pending-file', title: item.file.name }, icon('file'), el('span', { text: item.file.name })),
          el('button', {
            type: 'button',
            'aria-label': `Remove ${item.file.name || 'image'}`,
            onclick: () => {
              if (item.url) URL.revokeObjectURL(item.url);
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
      const image = IMAGE_TYPES.includes(file.type);
      if (!image && !isTextFile(file)) {
        alert(`${file.name || 'That file'} is not an image (PNG, JPEG, GIF, WebP) or a text file.`);
        continue;
      }
      if (file.size > (image ? MAX_IMAGE_BYTES : MAX_TEXT_BYTES)) {
        alert(`${file.name || 'That file'} is over ${image ? '5 MB' : '1 MB'}.`);
        continue;
      }
      if (pending.length >= MAX_IMAGES) {
        alert('You can attach up to 4 files.');
        break;
      }
      pending.push({ file, url: image ? URL.createObjectURL(file) : null });
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
      for (const item of pending) if (item.url) URL.revokeObjectURL(item.url);
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
  const people = (await peopleCache.get(key)).filter((p) => p.name !== state.me.name);
  return [...people, { name: 'all', kind: 'all', owner: null }];
}

attachMentionAutocomplete($('composer-text'), () => roomPeople(state.room), el);
attachMentionAutocomplete($('thread-text'), () => roomPeople(state.rooms.find((r) => r.ref === state.thread?.room)), el);

/* Inbox and search */

let inboxTimer = null;

function scheduleInbox() {
  clearTimeout(inboxTimer);
  inboxTimer = setTimeout(() => void refreshInbox(), 250);
}

// Flags and stalled tasks arrive without a mention, so new ones get a notification of their own.
// The first Inbox load only records what is already there.
let announced = null;

function announceNew(inbox) {
  const items = [
    ...inbox.flags.map((f) => ({
      key: `flag-${f.id}`,
      title: `${f.flagger} flagged something`,
      body: f.reason,
      target: f.message ? { id: f.message.id, room: f.message.room, threadId: f.message.threadId } : null,
    })),
    ...inbox.stalled.map((t) => ({
      key: `stalled-${t.id}`,
      title: `Task #${t.id} has stalled`,
      body: `No sign of life from ${t.assignee}: ${t.request}`,
      target: { id: t.messageId, room: t.room, threadId: null },
    })),
  ];
  if (announced) {
    for (const item of items.filter((i) => !announced.has(i.key))) {
      void notify.show({ title: item.title, body: item.body, tag: item.key, hash: '', target: item.target }, openFromNotification);
    }
  }
  announced = new Set(items.map((i) => i.key));
}

function openFromNotification({ hash, target }) {
  window.focus();
  if (target) void jumpTo(target);
  else if (hash) location.hash = hash;
  else void showInbox();
}

function renderNotifyButton() {
  const button = $('notify');
  const on = notify.enabled();
  button.hidden = !notify.supported() && !('serviceWorker' in navigator);
  button.replaceChildren(icon(on ? 'bell' : 'bell-off'));
  button.title = on ? 'Notifications on (click to turn off)' : 'Turn on notifications';
  button.setAttribute('aria-label', button.title);
  button.setAttribute('aria-pressed', String(on));
}

$('notify').addEventListener('click', async () => {
  try {
    await notify.toggle();
  } catch (err) {
    alert(err.message);
  }
  renderNotifyButton();
});

async function refreshInbox() {
  const inbox = await api('/inbox').catch(() => null);
  if (!inbox) return;
  const c = inbox.counts;
  const count = c.approvals + c.questions + c.flags + c.stalled + (c.reviews ?? 0) + (c.suggestions ?? 0) + c.unseenMentions;
  notify.setBadge(count);
  announceNew(inbox);
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

function inboxHeading(text, count) {
  return el('h3', { class: 'inbox-heading' }, text, count ? el('span', { text: String(count) }) : null);
}

function renderInbox(inbox) {
  const sections = [];
  if (inbox.approvals.length) {
    sections.push(
      inboxHeading('Needs your decision', inbox.approvals.length),
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
  if (inbox.questions.length) {
    sections.push(
      inboxHeading('Questions for you', inbox.questions.length),
      ...inbox.questions.map((q) =>
        el(
          'div',
          { class: 'inbox-card' },
          el(
            'button',
            { class: 'inbox-row', type: 'button', onclick: () => void jumpTo({ id: q.messageId, room: q.room, threadId: q.threadId }) },
            el(
              'span',
              { class: 'inbox-meta' },
              el('strong', { text: q.asker }),
              el('span', { class: 'muted', text: ` · task #${q.taskId} · ${q.room}${q.audience === 'project' ? ' · asked of everyone' : ''}` }),
            ),
            q.kind === 'plan' ? el('span', { class: 'inbox-text', text: 'Proposed a plan; edit it if needed, then approve or reject.' }) : el('span', { class: 'inbox-text', text: q.question }),
          ),
          el('div', { class: 'inbox-answer' }, q.kind === 'plan' ? planBox(q.id, q.question, scheduleInbox) : answerBox(q.id, scheduleInbox)),
        ),
      ),
    );
  }
  if (inbox.reviews?.length) {
    sections.push(
      inboxHeading('Reviews for you', inbox.reviews.length),
      ...inbox.reviews.map((r) =>
        el(
          'div',
          { class: 'inbox-card' },
          el(
            'button',
            {
              class: 'inbox-row',
              type: 'button',
              onclick: () => (r.ticket ? void tickets.openTicket(r.ticket) : void jumpTo({ id: r.messageId, room: r.room, threadId: null })),
            },
            el('span', { class: 'inbox-meta' }, el('strong', { text: r.requester }), el('span', { class: 'muted', text: ` asks you to review ${r.target} · ${r.room}` })),
            el('span', { class: 'inbox-text', text: r.summary }),
          ),
          el('div', { class: 'row-end' }, reviewButtons(r.id)),
        ),
      ),
    );
  }
  if (inbox.flags.length) {
    sections.push(
      inboxHeading('Flagged by your agents', inbox.flags.length),
      ...inbox.flags.map((f) =>
        el(
          'div',
          { class: 'inbox-card' },
          el(
            'button',
            {
              class: 'inbox-row',
              type: 'button',
              onclick: () =>
                f.message ? void jumpTo({ id: f.message.id, room: f.message.room, threadId: f.message.threadId }) : void tickets.openTicket(f.ticket.ref),
            },
            el(
              'span',
              { class: 'inbox-meta' },
              el('strong', { text: f.flagger }),
              el('span', { class: 'muted', text: f.message ? ` flagged a message from ${f.message.author} in ${f.message.room}` : ` flagged ${f.ticket.ref}` }),
            ),
            el('span', { class: 'inbox-text', text: f.reason }),
            el('span', { class: 'flag-quote', text: f.message ? snippet(f.message.text, 240) : f.ticket.title }),
          ),
          el(
            'div',
            { class: 'row-end' },
            el('button', {
              class: 'ghost small',
              type: 'button',
              text: 'Dismiss',
              onclick: async () => {
                await api(`/flags/${f.id}/dismiss`, { method: 'POST' });
                scheduleInbox();
              },
            }),
          ),
        ),
      ),
    );
  }
  if (inbox.suggestions?.length) {
    sections.push(
      inboxHeading('Suggested follow-ups', inbox.suggestions.length),
      ...inbox.suggestions.map((f) =>
        el(
          'div',
          { class: 'inbox-card' },
          el(
            'button',
            { class: 'inbox-row', type: 'button', onclick: () => void openTask(f.taskId) },
            el('span', { class: 'inbox-meta' }, el('strong', { text: f.author }), el('span', { class: 'muted', text: ` suggests, from task #${f.taskId} · ${f.project}` })),
            el('span', { class: 'inbox-text', text: f.title }),
            f.description ? el('span', { class: 'flag-quote', text: snippet(f.description, 240) }) : null,
          ),
          el(
            'div',
            { class: 'row-end' },
            el('button', { class: 'ghost small', type: 'button', text: 'Dismiss', onclick: () => void decideSuggestion(f.id, 'dismiss') }),
            el('button', { class: 'primary small', type: 'button', text: 'File ticket', onclick: () => void decideSuggestion(f.id, 'accept') }),
          ),
        ),
      ),
    );
  }
  if (inbox.stalled.length) {
    sections.push(
      inboxHeading('Stalled', inbox.stalled.length),
      ...inbox.stalled.map((t) =>
        el(
          'button',
          { class: 'inbox-row', type: 'button', onclick: () => void jumpTo({ id: t.messageId, room: t.room, threadId: null }) },
          el('span', { class: 'inbox-meta' }, el('strong', { text: `Task #${t.id}` }), el('span', { class: 'muted', text: ` → ${t.assignee} · no sign of life` })),
          el('span', { class: 'inbox-text', text: snippet(t.request) }),
        ),
      ),
    );
  }
  if (inbox.tasks.length) {
    sections.push(
      inboxHeading(state.me.kind === 'user' ? "Your agents' open tasks" : 'Your open tasks', inbox.tasks.length),
      ...inbox.tasks.map((t) =>
        el(
          'button',
          { class: 'inbox-row', type: 'button', onclick: () => void jumpTo({ id: t.messageId, room: t.room, threadId: null }) },
          el(
            'span',
            { class: 'inbox-meta' },
            el('strong', { text: `Task #${t.id}` }),
            el('span', { class: 'muted', text: ` → ${t.assignee} · ` }),
            t.stalled ? el('span', { class: 'chip stalled', text: 'Stalled' }) : el('span', { class: `chip task-${t.state}`, text: TASK_LABEL[t.state] }),
          ),
          el('span', { class: 'inbox-text', text: snippet(t.request) }),
        ),
      ),
    );
  }
  if (inbox.tickets.length) {
    sections.push(inboxHeading('Assigned to you', inbox.tickets.length), ...inbox.tickets.map((t) => tickets.inboxRow(t)));
  }
  // Open questions are listed above with an answer box; don't repeat them as mentions.
  const mentions = inbox.mentions.filter((m) => m.question?.state !== 'open');
  sections.push(inboxHeading('Mentions'));
  sections.push(
    ...(mentions.length ? mentions.map((m) => messageRow(m, { unseen: !m.seen })) : [el('p', { class: 'panel-intro muted small', text: 'No one has mentioned you yet.' })]),
  );
  if (!inbox.approvals.length && !inbox.questions.length && !inbox.flags.length && !inbox.stalled.length && !inbox.tasks.length && !inbox.reviews?.length && !inbox.suggestions?.length) {
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

async function openTask(id) {
  try {
    const task = await api(`/tasks/${id}`);
    await jumpTo({ id: task.messageId, room: task.room, threadId: null });
  } catch (err) {
    alert(err.message);
  }
}

const KIND_LABEL = { message: 'Message', ticket: 'Ticket', note: 'Note', task: 'Task' };

function openHit(hit) {
  if (hit.kind === 'message') return jumpTo({ id: Number(hit.ref), room: hit.room, threadId: hit.threadId === Number(hit.ref) ? null : hit.threadId });
  if (hit.kind === 'ticket') return tickets.openTicket(hit.ref);
  if (hit.kind === 'note') {
    location.hash = `~${hit.project}/notes`;
    return undefined;
  }
  return jumpTo({ id: hit.threadId, room: hit.room, threadId: null });
}

async function runSearch(query, kind = '') {
  openPanel('search', `Search: ${query}`);
  let results;
  try {
    results = await api(`/search?q=${encodeURIComponent(query)}${kind ? `&kind=${kind}` : ''}&limit=60`);
  } catch (err) {
    $('panel-body').replaceChildren(el('p', { class: 'empty muted', text: err.message }));
    return;
  }
  if (state.panel !== 'search') return;
  const filter = el(
    'div',
    { class: 'search-kinds', role: 'group', 'aria-label': 'What to search' },
    [['', 'All'], ...Object.entries(KIND_LABEL).map(([k, label]) => [k, `${label}s`])].map(([k, label]) =>
      el('button', { class: `small${k === kind ? ' active' : ' ghost'}`, type: 'button', 'aria-pressed': String(k === kind), text: label, onclick: () => void runSearch(query, k) }),
    ),
  );
  $('panel-body').replaceChildren(
    filter,
    el('p', { class: 'panel-intro muted small', text: results.length ? `${results.length}${results.length === 60 ? '+' : ''} ${results.length === 1 ? 'result' : 'results'}, newest first` : 'Nothing matches every word.' }),
    ...results.map((hit) =>
      el(
        'button',
        { class: 'inbox-row', type: 'button', onclick: () => void openHit(hit) },
        el(
          'span',
          { class: 'inbox-meta' },
          el('span', { class: `chip kind-${hit.kind}`, text: KIND_LABEL[hit.kind] }),
          el('strong', { text: ` ${hit.title}` }),
          el('time', { class: 'muted', text: ` · ${formatTime(hit.at)}` }),
        ),
        el('span', { class: 'inbox-text', text: hit.snippet }),
      ),
    ),
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
  if (state.view !== 'room' || state.room?.ref !== target.room) {
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

$('portfolio').addEventListener('click', () => {
  $('sidebar').classList.remove('open');
  location.hash = '#!portfolio';
});
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
  if (state.me.kind === 'user' && state.projects.length === 0 && !guide.stepsDismissed()) void guide.showSteps();
  connect();
  void refreshInbox();
  renderNotifyButton();
  void notify.registerWorker(openFromNotification);
}

async function showLogin() {
  $('app').hidden = true;
  $('login').hidden = false;
  const setup = await api('/setup').catch(() => ({ needed: false }));
  if (setup.needed) return guide.showSetup(/^#setup=([\w-]+)$/.exec(location.hash)?.[1], () => start());
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
$('getting-started').addEventListener('click', () => {
  $('sidebar').classList.remove('open');
  return state.panel === 'start' ? closePanel() : void guide.showSteps();
});
$('help').addEventListener('click', () => {
  $('sidebar').classList.remove('open');
  return state.panel === 'help' ? closePanel() : guide.showHelp();
});
$('ask-agent').addEventListener('click', () => void guide.askAgent());
$('empty-ask').addEventListener('click', () => void guide.askAgent());
$('add-member').addEventListener('click', () => void addMember());
$('show-members').addEventListener('click', () => (state.panel === 'members' ? closePanel() : void showMembers()));
$('show-locks').addEventListener('click', () => (state.panel === 'locks' ? closePanel() : void showLocks()));
$('close-panel').addEventListener('click', closePanel);
$('load-older').addEventListener('click', () => void loadOlder());
$('toggle-sidebar').addEventListener('click', () => $('sidebar').classList.toggle('open'));
window.addEventListener('hashchange', () => void selectRoom());
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && state.view === 'room' && state.room) {
    state.unread.delete(state.room.ref);
    state.mentioned.delete(state.room.ref);
    renderNav();
  }
});

const portfolio = createPortfolio({
  api,
  el,
  richText,
  me: () => state.me,
  projects: () => state.projects,
  $,
  onJoin: () => loadStructure(),
});

const tickets = createTickets({
  api,
  el,
  icon,
  avatar,
  richText,
  openPanel,
  closePanel,
  panel: () => state.panel,
  jumpTo,
  me: () => state.me,
  rooms: () => state.rooms,
  $,
});

const guide = createGuide({
  api,
  el,
  $,
  me: () => state.me,
  projects: () => state.projects,
  room: () => state.room,
  openPanel,
  closePanel,
  panel: () => state.panel,
  loadStructure,
  newProject,
  showMyAgents,
  onChange: () => void guide.refreshSteps(),
});

const TASK_COMMAND = /^\/task\s+@?([a-z0-9][a-z0-9-]{0,31})\s+([\s\S]+)$/;
// Optional budgets right after the agent: `/task @agent 30m $2 do the thing`.
const BUDGET_TOKEN = /^(?:(\d+)(m|h)|\$(\d+(?:\.\d{1,2})?))\s+/;

function parseTask(text) {
  const match = TASK_COMMAND.exec(text);
  if (!match) throw new Error('Use /task @agent what you need (optionally /task @agent 30m $2 what you need)');
  let request = match[2];
  const body = { agent: match[1] };
  for (let token = BUDGET_TOKEN.exec(request); token; token = BUDGET_TOKEN.exec(request)) {
    if (token[1]) body.budget_minutes = Number(token[1]) * (token[2] === 'h' ? 60 : 1);
    else body.budget_cents = Math.round(Number(token[3]) * 100);
    request = request.slice(token[0].length);
  }
  return { ...body, request };
}

wireComposer($('composer'), $('composer-text'), $('composer-pending'), () => state.room.ref, async (text, ids) => {
  if (text.startsWith('/task')) {
    if (ids.length) throw new Error('Tasks cannot carry attachments yet; post the file, then create the task.');
    await api('/tasks', { method: 'POST', body: { ...parseTask(text), room: state.room.ref } });
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
