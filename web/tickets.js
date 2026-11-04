// Tickets: board, list, ticket details, milestones, cycles and workflow settings for one project.
// Builds DOM through the `el` helper from app.js; ticket text is untrusted and only ever set as text.

import { parseCommand } from './commands.js';

const TABS = [
  ['board', 'Board'],
  ['list', 'List'],
  ['milestones', 'Milestones'],
  ['cycles', 'Cycles'],
  ['notes', 'Notes'],
  ['files', 'Files'],
  ['schedules', 'Schedules'],
  ['integrations', 'Integrations'],
  ['settings', 'Settings'],
];
/** The views most people use every day; the rest wait behind "More". */
const MAIN_TABS = ['board', 'list', 'notes', 'files'];
const CRON_PRESETS = [
  ['0 9 * * 1-5', 'Weekdays at 9:00'],
  ['0 9 * * 1', 'Mondays at 9:00'],
  ['0 9 * * *', 'Every day at 9:00'],
  ['0 * * * *', 'Every hour'],
  ['0 17 * * 5', 'Fridays at 17:00'],
];
const PRIORITY_LABEL = { none: 'No priority', urgent: 'Urgent', high: 'High', medium: 'Medium', low: 'Low' };
const PRIORITY_ORDER = ['urgent', 'high', 'medium', 'low', 'none'];
const CATEGORY_LABEL = { backlog: 'Backlog', unstarted: 'Unstarted', started: 'Started', completed: 'Completed', canceled: 'Canceled' };
const TASK_TEXT = {
  awaiting_approval: 'Waiting for approval',
  requested: 'Queued',
  accepted: 'Working',
  needs_input: 'Needs input',
  done: 'Task done',
  failed: 'Task failed',
  declined: 'Task declined',
  cancelled: 'Task cancelled',
};
const TASK_EVENT = {
  requested: (d) => `started task #${d.taskId} for ${d.agent}`,
  awaiting_approval: (d) => `asked to start task #${d.taskId} for ${d.agent}, waiting for its owner's approval`,
  accepted: (d) => `picked up task #${d.taskId}`,
  needs_input: (d) => `asked a question on task #${d.taskId}`,
  answered: (d) => `answered ${d.agent}'s question on task #${d.taskId}`,
  done: (d) => `finished task #${d.taskId}`,
  failed: (d) => `could not finish task #${d.taskId}`,
  declined: (d) => `task #${d.taskId} for ${d.agent} was declined`,
  cancelled: (d) => `task #${d.taskId} for ${d.agent} was cancelled`,
};
const OPEN_TASK = ['awaiting_approval', 'requested', 'accepted', 'needs_input'];
const EMPTY_FILTERS = { q: '', assignee: '', label: '', priority: '', milestone: '', cycle: '', folder: '', blocked: '' };

/** Why a ticket is blocked, for tooltips: open blocking tickets and any outside reason. */
function blockedWhy(ticket) {
  return [ticket.blockedBy.length ? `Waiting on ${ticket.blockedBy.join(', ')}` : null, ticket.blockedReason].filter(Boolean).join('; ');
}

export function createTickets(ctx) {
  const { api, el, icon, avatar, richText, openPanel, closePanel, panel, jumpTo, me, rooms, $ } = ctx;
  const onNav = () => ctx.onNav?.();
  const t = { project: null, tab: 'board', plan: null, tickets: [], filters: { ...EMPTY_FILTERS }, open: null, editing: false, timer: null };
  const root = $('tickets-view');

  /* Small builders */

  const select = (value, options, onchange, props = {}) =>
    el(
      'select',
      { ...props, onchange: (event) => onchange(event.target.value) },
      options.map(([v, label]) => el('option', { value: v, selected: String(v) === String(value ?? '') ? true : null, text: label })),
    );

  const statusIcon = (category) => el('span', { class: `status-icon cat-${category}`, 'aria-hidden': 'true' });

  const priorityIcon = (priority) =>
    el(
      'span',
      { class: `prio prio-${priority}`, title: PRIORITY_LABEL[priority], 'aria-label': PRIORITY_LABEL[priority] },
      priority === 'urgent' ? '!' : [el('i'), el('i'), el('i')],
    );

  const labelChip = (label) => {
    const dot = el('span', { class: 'label-dot' });
    dot.style.background = label.color;
    return el('span', { class: 'label-chip' }, dot, el('span', { text: label.name }));
  };

  const ago = (iso) => {
    const seconds = Math.max(0, (Date.now() - new Date(iso)) / 1000);
    if (seconds < 60) return 'just now';
    if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`;
    if (seconds < 86400) return `${Math.round(seconds / 3600)}h ago`;
    return new Date(iso).toLocaleDateString([], { month: 'short', day: 'numeric' });
  };

  const shortDate = (date) => new Date(`${date}T00:00:00`).toLocaleDateString([], { month: 'short', day: 'numeric' });
  const today = () => new Date().toISOString().slice(0, 10);

  const progressBar = (p) => {
    const fill = el('span', { class: 'progress-fill' });
    fill.style.width = `${p.tickets ? Math.round((p.completed / p.tickets) * 100) : 0}%`;
    return el(
      'div',
      { class: 'progress' },
      el('div', { class: 'progress-track' }, fill),
      el('span', {
        class: 'muted small',
        text: `${p.completed} of ${p.tickets} done${p.points ? ` · ${p.completedPoints} of ${p.points} points` : ''}`,
      }),
    );
  };

  const taskBadge = (task) =>
    task
      ? el(
          'span',
          { class: `task-badge task-${task.state}` },
          task.state === 'accepted' ? el('span', { class: 'working-dot', 'aria-hidden': 'true' }) : null,
          TASK_TEXT[task.state],
        )
      : null;

  /**
   * The one state a ticket is in, readable without hovering (and in a screenshot): waiting on you (or
   * on someone), blocked by what, stale (no status change in 7 days), or being worked on.
   */
  const STALE_DAYS = 7;
  function cardState(ticket) {
    const open = !['completed', 'canceled'].includes(ticket.status.category);
    if (!open) return null;
    const waiting = ticket.waitingOn && !(ticket.waitingOn.snoozedUntil && ticket.waitingOn.snoozedUntil > new Date().toISOString()) ? ticket.waitingOn : null;
    if (waiting && waiting.person === me()?.name) return { kind: 'waiting-you', icon: 'bell', text: `Waiting on you: ${waiting.ask}` };
    if (ticket.blocked) {
      const by = ticket.blockedBy.length ? `Blocked by ${ticket.blockedBy.slice(0, 2).join(', ')}${ticket.blockedBy.length > 2 ? ` +${ticket.blockedBy.length - 2}` : ''}` : `Blocked: ${ticket.blockedReason}`;
      return { kind: 'blocked', icon: 'lock', text: ticket.blockedBy.length && ticket.blockedReason ? `${by}; ${ticket.blockedReason}` : by };
    }
    if (waiting) return { kind: 'waiting', icon: 'clock', text: `Waiting on ${waiting.person}` };
    if (ticket.task && ['accepted', 'needs_input'].includes(ticket.task.state)) return { kind: 'working', icon: 'bot', text: ticket.task.state === 'needs_input' ? 'Agent asked a question' : 'Working' };
    const days = Math.floor((Date.now() - Date.parse(ticket.statusChangedAt ?? ticket.updatedAt)) / 86_400_000);
    if (ticket.status.category !== 'backlog' && days >= STALE_DAYS) return { kind: 'stale', icon: 'clock', text: `Stale: ${ticket.status.name} for ${days} days` };
    return null;
  }
  const stateLine = (ticket) => {
    const state = cardState(ticket);
    return state ? el('div', { class: `card-state state-${state.kind}` }, icon(state.icon), el('span', { text: state.text })) : null;
  };
  const nextStepLine = (ticket) => {
    if (['completed', 'canceled'].includes(ticket.status.category)) return null;
    if (ticket.nextStep) return el('div', { class: 'ticket-next', text: `Next: ${ticket.nextStep.text}${ticket.nextStep.for ? ` (${ticket.nextStep.for})` : ''}` });
    // "No next step" only where it is a useful nudge: work in progress that nothing else explains.
    return ticket.status.category === 'started' && !cardState(ticket) ? el('div', { class: 'ticket-next none', text: 'No next step' }) : null;
  };
  // The board shows what matters by default: recent Done only, Backlog folded to a count.
  const FOCUS_KEY = 'orco.boardFocus';
  const focusOn = () => {
    try {
      return localStorage.getItem(FOCUS_KEY) !== '0';
    } catch {
      return true;
    }
  };
  const setFocus = (on) => {
    try {
      localStorage.setItem(FOCUS_KEY, on ? '1' : '0');
    } catch {
      // Private windows: the toggle still works for this page.
    }
    t.focus = on;
    const box = root.querySelector('.board-focus input');
    if (box) box.checked = on;
    renderTab();
  };

  // Plans by project: the board shows one project while the panel may show a ticket from another.
  const plans = new Map();
  const people = () => t.plan?.members ?? [];

  /* Loading */

  async function show(project, tab) {
    if (t.project !== project) {
      t.filters = { ...EMPTY_FILTERS };
      t.plan = null;
    }
    t.project = project;
    t.tab = TABS.some(([key]) => key === tab) ? tab : 'board';
    renderShell();
    await load();
  }

  // True while someone is typing or choosing in a field inside `container`; live updates wait for them.
  const typing = (container) => {
    const active = document.activeElement;
    return Boolean(container && active && container.contains(active) && active.matches('input, textarea, select'));
  };

  async function load() {
    const project = t.project;
    const p = encodeURIComponent(project);
    const [plan, tickets, notes, schedules, files, integrations] = await Promise.all([
      api(`/projects/${p}/plan`),
      fetchTickets(),
      t.tab === 'notes' ? api(`/projects/${p}/notes`) : Promise.resolve(t.notes ?? []),
      t.tab === 'schedules' ? api(`/schedules?project=${p}`) : Promise.resolve(t.schedules ?? []),
      t.tab === 'files' ? api(`/projects/${p}/files`) : Promise.resolve(t.files ?? []),
      t.tab === 'integrations'
        ? Promise.all([api(`/hooks?project=${p}`), api(`/projects/${p}/secrets`), api(`/leases?project=${p}`)]).then(([hooks, secrets, leases]) => ({ hooks, secrets, leases }))
        : Promise.resolve(t.integrations ?? null),
    ]);
    if (t.project !== project) return;
    t.plan = plan;
    t.notes = notes;
    t.schedules = schedules;
    t.files = files;
    t.integrations = integrations;
    plans.set(project, plan);
    // A filter on a folder that was removed or renamed would show nothing; drop it.
    if (t.filters.folder && t.filters.folder !== 'none' && !(plan.folders ?? []).some((f) => f.name.toLowerCase() === t.filters.folder.toLowerCase())) {
      t.filters.folder = '';
      void refreshTickets();
    }
    t.tickets = tickets;
    onNav();
    const filters = root.querySelector('.ticket-filters');
    if (!root.querySelector('.ticket-tabs')) renderShell();
    else if (filters && !typing(filters)) filters.replaceWith(filterBar());
    renderTab();
  }

  async function planFor(project, fresh = false) {
    if (fresh || !plans.has(project)) plans.set(project, await api(`/projects/${encodeURIComponent(project)}/plan`));
    return plans.get(project);
  }

  function fetchTickets() {
    const params = new URLSearchParams({ project: t.project, limit: '500' });
    const f = t.filters;
    if (f.q) params.set('q', f.q);
    if (f.assignee) params.set('assignee', f.assignee);
    if (f.label) params.set('label', f.label);
    if (f.priority) params.set('priority', f.priority);
    if (f.milestone) params.set('milestone', f.milestone);
    if (f.cycle) params.set('cycle', f.cycle);
    if (f.folder) params.set('folder', f.folder);
    if (f.blocked) params.set('blocked', f.blocked);
    return api(`/tickets?${params}`);
  }

  function onEvent(event) {
    if (!t.project || !root || root.hidden) {
      if (event.ref && event.ref === t.open && panel() === 'ticket') scheduleDetail();
      if (event.ref === null && panel() === 'ticket') {
        t.replan = true;
        scheduleDetail();
      }
      return;
    }
    clearTimeout(t.timer);
    t.timer = setTimeout(() => void load(), 250);
    if (event.ref && event.ref === t.open && panel() === 'ticket') scheduleDetail();
    if (event.ref === null && panel() === 'ticket') {
      t.replan = true;
      scheduleDetail();
    }
  }

  let detailTimer = null;
  function scheduleDetail() {
    clearTimeout(detailTimer);
    detailTimer = setTimeout(() => void openTicket(t.open, { refresh: true }), 250);
  }

  /* Shell: tabs and filters */

  function renderShell() {
    const tabs = el(
      'nav',
      { class: 'ticket-tabs', 'aria-label': 'Ticket views' },
      TABS.filter(([key]) => MAIN_TABS.includes(key) || key === t.tab).map(([key, label]) =>
        el('a', { href: `#~${t.project}/${key}`, class: 'ticket-tab', 'aria-current': key === t.tab ? 'page' : null, text: label }),
      ),
      moreTabs(),
      el('span', { class: 'spacer' }),
      el('button', { class: 'primary small', type: 'button', onclick: () => openNewTicket() }, icon('plus'), 'New ticket'),
    );
    const body = el('div', { id: 'ticket-body', class: `ticket-body tab-${t.tab}` });
    root.replaceChildren(...[tabs, t.tab === 'board' || t.tab === 'list' ? filterBar() : null, body].filter(Boolean));
    if (!t.plan) body.append(el('p', { class: 'muted empty', text: 'Loading…' }));
  }

  function moreTabs() {
    const rest = TABS.filter(([key]) => !MAIN_TABS.includes(key) && key !== t.tab);
    const menu = el(
      'details',
      { class: 'more-menu ticket-more' },
      el('summary', { class: 'ticket-tab', text: 'More' }),
      el('div', { class: 'menu' }, rest.map(([key, label]) => el('a', { href: `#~${t.project}/${key}`, class: 'ghost small button-link', text: label, onclick: () => (menu.open = false) }))),
    );
    menu.addEventListener('toggle', () => {
      if (!menu.open) return;
      const close = (event) => {
        if (menu.contains(event.target)) return;
        menu.open = false;
        document.removeEventListener('click', close);
      };
      setTimeout(() => document.addEventListener('click', close));
    });
    return menu;
  }

  function filterBar() {
    const f = t.filters;
    const set = (key) => (value) => {
      f[key] = value;
      void refreshTickets();
    };
    const search = el('input', { type: 'search', placeholder: 'Filter by title, text or key', value: f.q || null, 'aria-label': 'Filter tickets' });
    let timer = null;
    search.addEventListener('input', () => {
      clearTimeout(timer);
      timer = setTimeout(() => set('q')(search.value.trim()), 250);
    });
    const plan = t.plan;
    // Only the search box until someone asks for more, or a filter is already set.
    const open = t.showFilters || Object.entries(f).some(([key, value]) => key !== 'q' && value);
    // The board's Focus switch lives on this line instead of a row of its own.
    const focus =
      t.tab === 'board'
        ? el(
            'label',
            { class: 'check small board-focus', title: 'Show Done from the last 7 days only, and fold Backlog to a count' },
            el('input', { type: 'checkbox', checked: (t.focus ??= focusOn()) ? true : null, onchange: (event) => setFocus(event.target.checked) }),
            'Focus',
          )
        : null;
    // Group the board and list by folder or parent ticket (#91); one folder on screen needs no groups.
    const canGroup = (t.tab === 'board' || t.tab === 'list') && plan && !f.folder && ((plan.folders ?? []).length || t.tickets.some((x) => x.parent));
    const group = canGroup
      ? select(
          groupMode(),
          [(plan.folders ?? []).length ? ['folder', 'Group by folder'] : null, ['parent', 'Group by parent ticket'], ['none', 'No groups']].filter(Boolean),
          setGroupMode,
          { 'aria-label': 'Group by', class: 'group-by' },
        )
      : null;
    if (!open) {
      return el(
        'div',
        { class: 'ticket-filters' },
        el('span', { class: 'filter-search' }, icon('search'), search),
        el('button', { class: 'ghost small', type: 'button', text: 'Filters', 'aria-expanded': 'false', onclick: () => ((t.showFilters = true), renderShell(), void refreshTickets()) }),
        el('span', { class: 'spacer' }),
        group,
        focus,
      );
    }
    return el(
      'div',
      { class: 'ticket-filters' },
      el('span', { class: 'filter-search' }, icon('search'), search),
      select(f.assignee, [['', 'Anyone'], ['me', 'Assigned to me'], ['none', 'Unassigned'], ...people().map((p) => [p.name, p.name])], set('assignee'), {
        'aria-label': 'Assignee',
      }),
      select(f.priority, [['', 'Any priority'], ...PRIORITY_ORDER.map((p) => [p, PRIORITY_LABEL[p]])], set('priority'), { 'aria-label': 'Priority' }),
      plan?.labels.length ? select(f.label, [['', 'Any label'], ...plan.labels.map((l) => [l.name, l.name])], set('label'), { 'aria-label': 'Label' }) : null,
      plan?.milestones.length
        ? select(f.milestone, [['', 'Any milestone'], ...plan.milestones.map((m) => [m.name, m.name])], set('milestone'), { 'aria-label': 'Milestone' })
        : null,
      plan?.cycles.length
        ? select(f.cycle, [['', 'Any cycle'], ['current', 'Current cycle'], ...plan.cycles.map((c) => [String(c.number), c.name])], set('cycle'), {
            'aria-label': 'Cycle',
          })
        : null,
      plan?.folders?.length
        ? select(
            f.folder,
            [['', 'Any folder'], ['none', 'No folder'], ...plan.folders.map((x) => [x.name, x.emoji ? `${x.emoji} ${x.name}` : x.name])],
            (value) => {
              f.folder = value;
              renderShell();
              void refreshTickets();
              onNav();
            },
            { 'aria-label': 'Folder' },
          )
        : null,
      select(f.blocked, [['', 'Blocked or not'], ['1', 'Blocked'], ['0', 'Not blocked']], set('blocked'), { 'aria-label': 'Blocked' }),
      el('button', {
        class: 'ghost small',
        type: 'button',
        text: Object.values(f).some(Boolean) ? 'Clear' : 'Hide',
        onclick: () => ((t.filters = { ...EMPTY_FILTERS }), (t.showFilters = false), renderShell(), void refreshTickets(), onNav()),
      }),
      el('span', { class: 'spacer' }),
      group,
      focus,
    );
  }

  async function refreshTickets() {
    const project = t.project;
    const tickets = await fetchTickets();
    if (t.project !== project) return;
    t.tickets = tickets;
    renderTab();
  }

  function renderTab() {
    const body = $('ticket-body');
    if (!body || !t.plan) return;
    if (typing(body) || dragging) {
      t.pendingTab = true;
      return;
    }
    t.pendingTab = false;
    const views = { board: renderBoard, list: renderList, milestones: renderMilestones, cycles: renderCycles, notes: renderNotes, files: renderFiles, schedules: renderSchedules, integrations: renderIntegrations, settings: renderSettings };
    body.replaceChildren(...[views[t.tab]()].flat(Infinity).filter((node) => node !== null && node !== undefined));
  }

  /** The agent's checklist on a ticket card: a tiny bar and "3/5" (#94). */
  function stepsPill(steps) {
    if (!steps?.total) return null;
    const fill = el('span', { class: 'steps-fill' });
    fill.style.width = `${Math.round((steps.done / steps.total) * 100)}%`;
    return el('span', { class: 'meta-pill steps-pill', title: `Agent checklist: ${steps.done} of ${steps.total} done` }, el('span', { class: 'steps-bar', 'aria-hidden': 'true' }, fill), `${steps.done}/${steps.total}`);
  }

  /** The ticket's agent at the bottom of its panel, always in view: "carlos-claude · working · 12m · step 2/4". */
  function workLine(ticket) {
    const task = ticket.task;
    if (!task || ticket.assignee?.kind !== 'agent' || !['awaiting_approval', 'requested', 'accepted', 'needs_input', 'failed'].includes(task.state)) return null;
    const word = { accepted: 'working', needs_input: 'waiting on an answer', awaiting_approval: 'waiting for approval', requested: 'queued', failed: 'failed' }[task.state];
    const minutes = Math.max(0, Math.round((Date.now() - Date.parse(task.since)) / 60000));
    const since = minutes < 60 ? `${minutes}m` : `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
    const step = task.steps ? ` · step ${Math.min(task.steps.done + 1, task.steps.total)}/${task.steps.total}` : '';
    return el(
      'div',
      { class: `work-status in-panel work-${word.replace(/\s+/g, '-')}`, role: 'status' },
      el('span', { class: 'work-dot', 'aria-hidden': 'true' }),
      el('strong', { text: ticket.assignee.name }),
      el('span', { text: ` · ${word} · ${since}${task.steps && task.steps.done === task.steps.total ? ` · ${task.steps.total}/${task.steps.total} done` : step}` }),
      el('span', { class: 'spacer' }),
      el('button', { class: 'ghost small', type: 'button', text: 'View task', onclick: () => void viewTask(task.id) }),
    );
  }

  /** A task changed: refresh the board or the open ticket when it is theirs, so checklists tick live. */
  function onTask(task) {
    if (!t.project || !root) return;
    const shown = t.tickets.some((x) => x.task?.id === task.id);
    if (shown && !root.hidden) {
      clearTimeout(t.timer);
      t.timer = setTimeout(() => void load(), 400);
    }
    if (panel() === 'ticket' && t.open && plans.size) {
      const open = t.tickets.find((x) => x.ref === t.open);
      if (open?.task?.id === task.id) scheduleDetail();
    }
  }

  /* Folders and grouping (#91) */

  const GROUP_KEY = (project) => `orco.groupBy.${project}`;
  const LANES_KEY = (project) => `orco.lanesFolded.${project}`;

  /** How the board and list group tickets: by folder, by parent ticket, or not at all. */
  function groupMode() {
    if (t.filters.folder) return 'none';
    let stored = null;
    try {
      stored = localStorage.getItem(GROUP_KEY(t.project));
    } catch {
      // Private windows: the default applies.
    }
    const folders = t.plan.folders ?? [];
    const mode = stored ?? t.groupBy ?? (folders.length ? 'folder' : 'none');
    return mode === 'folder' && !folders.length ? 'none' : mode;
  }

  function setGroupMode(mode) {
    t.groupBy = mode;
    try {
      localStorage.setItem(GROUP_KEY(t.project), mode);
    } catch {
      // Kept for this page only.
    }
    renderShell();
    renderTab();
  }

  function foldedLanes() {
    if (t.lanesFor !== t.project) {
      t.lanesFor = t.project;
      t.lanesFolded = new Set();
      try {
        t.lanesFolded = new Set(JSON.parse(localStorage.getItem(LANES_KEY(t.project)) ?? '[]'));
      } catch {
        // Nothing folded.
      }
    }
    return t.lanesFolded;
  }

  function setLaneFolded(key, folded) {
    const set = foldedLanes();
    if (folded === set.has(key)) return;
    if (folded) set.add(key);
    else set.delete(key);
    try {
      localStorage.setItem(LANES_KEY(t.project), JSON.stringify([...set]));
    } catch {
      // Kept for this page only.
    }
  }

  const isOpen = (ticket) => !['completed', 'canceled'].includes(ticket.status.category);

  /**
   * The groups for the current mode, in order: every folder (so a ticket can be dragged into an empty
   * one) and "No folder" when anything is outside them; or each parent ticket and "No parent". Each
   * carries the change that moves a ticket into it.
   */
  function lanes(mode, tickets) {
    if (mode === 'folder') {
      const groups = (t.plan.folders ?? []).map((f) => ({
        key: `folder:${f.id}`,
        label: f.name,
        emoji: f.emoji,
        tickets: tickets.filter((x) => x.folder?.id === f.id),
        move: { folder: f.name },
        newTicket: { folder: f.name },
      }));
      const loose = tickets.filter((x) => !x.folder);
      if (loose.length) groups.push({ key: 'folder:none', label: 'No folder', emoji: null, tickets: loose, move: { folder: null }, newTicket: {} });
      return groups.map((g) => ({ ...g, open: g.tickets.filter(isOpen).length }));
    }
    if (mode === 'parent') {
      const refs = [...new Set(tickets.map((x) => x.parent).filter(Boolean))];
      const titleOf = (ref) => t.tickets.find((x) => x.ref === ref)?.title ?? '';
      const groups = refs.map((ref) => ({
        key: `parent:${ref}`,
        label: `${ref} ${titleOf(ref)}`.trim(),
        emoji: null,
        tickets: tickets.filter((x) => x.parent === ref),
        move: { parent: ref },
        newTicket: { parent: ref },
      }));
      const loose = tickets.filter((x) => !x.parent);
      if (loose.length) groups.push({ key: 'parent:none', label: 'No parent', emoji: null, tickets: loose, move: { parent: null }, newTicket: {} });
      return groups.map((g) => ({ ...g, open: g.tickets.filter(isOpen).length }));
    }
    return null;
  }

  function laneHead(lane, folded, onToggle) {
    return el(
      'div',
      { class: 'lane-head' },
      el(
        'button',
        { class: 'lane-toggle', type: 'button', 'aria-expanded': String(!folded), onclick: onToggle },
        el('span', { class: 'fold-caret', 'aria-hidden': 'true', text: folded ? '▸' : '▾' }),
        lane.emoji ? el('span', { class: 'lane-emoji', 'aria-hidden': 'true', text: lane.emoji }) : null,
        el('span', { class: 'lane-name', text: lane.label }),
        el('span', { class: 'muted small', text: `${lane.open} open` }),
      ),
      el('button', { class: 'ghost icon', type: 'button', title: `New ticket in ${lane.label}`, 'aria-label': `New ticket in ${lane.label}`, onclick: () => openNewTicket(lane.newTicket) }, icon('plus')),
    );
  }

  /** The sidebar's folder links for the project on screen, each with its open count, and "+ New folder". */
  function navFolders(project) {
    if (project !== t.project || !t.plan || !root || root.hidden) return [];
    const add = el('button', { class: 'room-link folder-link folder-new', type: 'button', text: '+ New folder' });
    add.addEventListener('click', () => {
      const input = el('input', { class: 'folder-new-input', maxlength: '40', placeholder: 'Folder name', 'aria-label': 'New folder name' });
      const done = () => input.replaceWith(add);
      input.addEventListener('keydown', (event) => {
        if (event.key === 'Escape') done();
        if (event.key !== 'Enter' || !input.value.trim()) return;
        event.preventDefault();
        void api(`/projects/${encodeURIComponent(t.project)}/folders`, { method: 'POST', body: { name: input.value } })
          .then(() => load())
          .catch((err) => notify(err.message));
      });
      input.addEventListener('blur', () => setTimeout(done, 150));
      add.replaceWith(input);
      input.focus();
    });
    return [...folderLinks(), add];
  }

  function folderLinks() {
    return (t.plan.folders ?? []).map((f) =>
      el(
        'button',
        {
          class: `room-link folder-link${t.filters.folder.toLowerCase() === f.name.toLowerCase() ? ' active' : ''}`,
          type: 'button',
          'aria-current': t.filters.folder.toLowerCase() === f.name.toLowerCase() ? 'true' : null,
          title: `Show only ${f.name}`,
          onclick: () => pickFolder(f.name),
        },
        el('span', { class: 'folder-emoji', 'aria-hidden': 'true', text: f.emoji || '▪' }),
        el('span', { class: 'folder-name', text: f.name }),
        f.open ? el('span', { class: 'folder-count', text: String(f.open) }) : null,
      ),
    );
  }

  /** Shows one folder (or every folder again, when it is already the one shown). */
  function pickFolder(name) {
    t.filters.folder = t.filters.folder.toLowerCase() === name.toLowerCase() ? '' : name;
    if (t.tab !== 'board' && t.tab !== 'list') location.hash = `#~${t.project}/board`;
    else {
      renderShell();
      void refreshTickets();
    }
    onNav();
  }

  /** Lets cards dropped on `list` take `status`, and `move` (a folder or parent) when they come from another group. */
  function dropZone(list, status, move) {
    const line = el('div', { class: 'drop-line' });
    list.addEventListener('dragover', (event) => {
      if (!dragging) return;
      event.preventDefault();
      const cards = [...list.querySelectorAll('.ticket-card:not(.dragging)')];
      const next = cards.find((c) => event.clientY < c.getBoundingClientRect().top + c.offsetHeight / 2);
      list.insertBefore(line, next ?? null);
    });
    list.addEventListener('dragleave', (event) => {
      if (!list.contains(event.relatedTarget)) line.remove();
    });
    list.addEventListener('drop', (event) => {
      event.preventDefault();
      if (!dragging || !line.parentNode) return;
      const sortOf = (node) => t.tickets.find((x) => x.ref === node?.dataset?.ref)?.sort;
      const prev = sortOf(line.previousElementSibling?.classList.contains('ticket-card') ? line.previousElementSibling : null);
      const next = sortOf(line.nextElementSibling?.classList.contains('ticket-card') ? line.nextElementSibling : null);
      const sort = prev !== undefined && next !== undefined ? (prev + next) / 2 : next !== undefined ? next - 1 : prev !== undefined ? prev + 1 : 0;
      const moved = root.querySelector(`.ticket-card[data-ref="${CSS.escape(dragging.ref)}"]`);
      if (moved) list.insertBefore(moved, line);
      line.remove();
      const ticket = dragging;
      ticket.sort = sort;
      ticket.status = { ...ticket.status, id: status.id, name: status.name, category: status.category };
      void api(`/tickets/${ticket.ref}`, { method: 'POST', body: { status: status.name, sort, ...(move ?? {}) } })
        .then((result) => notify(result.warning))
        .catch((err) => notify(err.message))
        .finally(() => void refreshTickets());
    });
  }

  /** What Focus leaves in each column of `tickets`: recent Done only, Backlog folded to a count. */
  function focusCells(columns, tickets) {
    const byStatus = new Map(columns.map((s) => [s.id, []]));
    for (const ticket of tickets) byStatus.get(ticket.status.id)?.push(ticket);
    const hidden = new Map();
    if (t.focus) {
      const weekAgo = new Date(Date.now() - 7 * 86_400_000).toISOString();
      for (const status of columns) {
        const all = byStatus.get(status.id);
        if (status.category === 'completed') {
          const recent = all.filter((x) => (x.completedAt ?? x.updatedAt) >= weekAgo);
          hidden.set(status.id, all.length - recent.length);
          byStatus.set(status.id, recent);
        } else if (status.category === 'backlog' && !t.showBacklog) {
          hidden.set(status.id, all.length);
          byStatus.set(status.id, []);
        }
      }
    }
    return { byStatus, hidden };
  }

  const moreButton = (status, count) =>
    el('button', {
      class: 'ghost small column-more',
      type: 'button',
      text: status.category === 'backlog' ? `${count} in ${status.name}` : `+${count} older`,
      onclick: () => (status.category === 'backlog' ? ((t.showBacklog = true), renderTab()) : setFocus(false)),
    });

  /** The board in groups: one header row of statuses, then a collapsible lane per folder or parent. */
  function renderLaneBoard(columns, groups) {
    const totals = new Map(columns.map((s) => [s.id, t.tickets.filter((x) => x.status.id === s.id).length]));
    const header = el(
      'div',
      { class: 'lane-row lane-columns' },
      columns.map((status) =>
        el(
          'header',
          { class: `column-head cat-${status.category}` },
          statusIcon(status.category),
          el('span', { class: 'column-name', text: status.name }),
          el('span', { class: 'muted small', text: String(totals.get(status.id)) }),
          el('span', { class: 'spacer' }),
          el('button', { class: 'ghost icon', type: 'button', title: `New ticket in ${status.name}`, 'aria-label': `New ticket in ${status.name}`, onclick: () => openNewTicket({ status: status.name }) }, icon('plus')),
        ),
      ),
    );
    const folded = foldedLanes();
    const sections = groups.map((lane) => {
      const isFolded = folded.has(lane.key);
      const head = laneHead(lane, isFolded, () => {
        setLaneFolded(lane.key, !isFolded);
        renderTab();
      });
      if (isFolded) return el('section', { class: 'lane folded', 'data-lane': lane.key }, head);
      const { byStatus, hidden } = focusCells(columns, lane.tickets);
      const row = el(
        'div',
        { class: 'lane-row' },
        columns.map((status) => {
          const list = el('div', { class: 'column-cards lane-cards', 'data-status': status.name }, byStatus.get(status.id).map(card));
          dropZone(list, status, lane.move);
          return el('div', { class: `lane-cell cat-${status.category}` }, hidden.get(status.id) ? moreButton(status, hidden.get(status.id)) : null, list);
        }),
      );
      return el('section', { class: 'lane', 'data-lane': lane.key }, head, row);
    });
    return el('div', { class: 'board lanes' }, header, sections);
  }

  /* Board */

  let dragging = null;

  function card(ticket) {
    const node = el(
      'article',
      {
        class: `ticket-card${cardState(ticket) ? ` has-state state-edge-${cardState(ticket).kind}` : ''}`,
        tabindex: '0',
        draggable: 'true',
        'data-ref': ticket.ref,
        'aria-label': `${ticket.ref} ${ticket.title}`,
        onclick: () => void openTicket(ticket.ref),
        onkeydown: (event) => {
          if (event.key === 'Enter') void openTicket(ticket.ref);
        },
        ondragstart: (event) => {
          dragging = ticket;
          event.dataTransfer.setData('text/plain', ticket.ref);
          event.dataTransfer.effectAllowed = 'move';
          node.classList.add('dragging');
        },
        ondragend: () => {
          dragging = null;
          node.classList.remove('dragging');
          for (const line of root.querySelectorAll('.drop-line')) line.remove();
        },
      },
      stateLine(ticket),
      el('div', { class: 'ticket-card-top' }, el('span', { class: 'ticket-ref', text: ticket.ref }), ticket.assignee ? avatar(ticket.assignee.name, ticket.assignee.kind) : null),
      el('div', { class: 'ticket-title', text: ticket.title }),
      nextStepLine(ticket),
      el(
        'div',
        { class: 'ticket-meta' },
        ticket.priority !== 'none' ? priorityIcon(ticket.priority) : null,
        taskBadge(ticket.task),
        stepsPill(ticket.task?.steps),
        ticket.criteria.total
          ? el('span', { class: `meta-pill${ticket.criteria.done === ticket.criteria.total ? ' met' : ''}`, title: 'Acceptance criteria met', text: `${ticket.criteria.done}/${ticket.criteria.total}` })
          : null,
        ticket.labels.map(labelChip),
        ticket.estimate !== null ? el('span', { class: 'meta-pill', title: 'Estimate', text: `${ticket.estimate} pt` }) : null,
        ticket.dueDate ? el('span', { class: `meta-pill${ticket.dueDate < today() && !['completed', 'canceled'].includes(ticket.status.category) ? ' overdue' : ''}`, text: shortDate(ticket.dueDate) }) : null,
      ),
    );
    return node;
  }

  function renderBoard() {
    if (t.focus === undefined) t.focus = focusOn();
    const columns = t.plan.statuses.filter((s) => s.category !== 'canceled');
    const canceled = t.tickets.filter((x) => x.status.category === 'canceled').length;
    const note = canceled ? el('p', { class: 'muted small board-note', text: `${canceled} canceled ${canceled === 1 ? 'ticket is' : 'tickets are'} in the List view.` }) : null;
    const groups = lanes(groupMode(), t.tickets.filter((x) => x.status.category !== 'canceled'));
    if (groups) return [renderLaneBoard(columns, groups), note];
    const { byStatus, hidden } = focusCells(columns, t.tickets);
    const board = el(
      'div',
      { class: 'board' },
      columns.map((status) => {
        const tickets = byStatus.get(status.id);
        const list = el('div', { class: 'column-cards', 'data-status': status.name }, tickets.map(card));
        dropZone(list, status, null);
        return el(
          'section',
          { class: `board-column cat-${status.category}` },
          el(
            'header',
            { class: 'column-head' },
            statusIcon(status.category),
            el('span', { class: 'column-name', text: status.name }),
            el('span', { class: 'muted small', text: String(tickets.length + (hidden.get(status.id) ?? 0)) }),
            el('span', { class: 'spacer' }),
            el('button', { class: 'ghost icon', type: 'button', title: `New ticket in ${status.name}`, 'aria-label': `New ticket in ${status.name}`, onclick: () => openNewTicket({ status: status.name }) }, icon('plus')),
          ),
          // A column folded to a count shows the count at the top, not under an empty column.
          tickets.length ? list : null,
          hidden.get(status.id) ? moreButton(status, hidden.get(status.id)) : null,
          tickets.length ? null : list,
        );
      }),
    );
    return [board, note];
  }

  /* List */

  function listRow(ticket, { grouped = false } = {}) {
    return el(
      'button',
      {
        class: 'list-row',
        type: 'button',
        'data-ref': ticket.ref,
        // In groups, a row drags to another folder or parent.
        draggable: grouped ? 'true' : null,
        ondragstart: grouped
          ? (event) => {
              dragging = ticket;
              event.dataTransfer.setData('text/plain', ticket.ref);
              event.dataTransfer.effectAllowed = 'move';
            }
          : null,
        ondragend: grouped ? () => (dragging = null) : null,
        onclick: () => void openTicket(ticket.ref),
      },
      grouped ? statusIcon(ticket.status.category) : null,
      priorityIcon(ticket.priority),
      el('span', { class: 'ticket-ref', text: ticket.ref }),
      el('span', { class: 'list-title' }, el('span', { text: ticket.title }), stateLine(ticket), ticket.nextStep && !['completed', 'canceled'].includes(ticket.status.category) ? el('span', { class: 'ticket-next', text: `Next: ${ticket.nextStep.text}` }) : null),
      el('span', { class: 'list-meta' }, taskBadge(ticket.task), ticket.labels.map(labelChip), ticket.estimate !== null ? el('span', { class: 'meta-pill', text: `${ticket.estimate} pt` }) : null, ticket.dueDate ? el('span', { class: 'meta-pill', text: shortDate(ticket.dueDate) }) : null),
      ticket.assignee ? avatar(ticket.assignee.name, ticket.assignee.kind) : el('span', { class: 'avatar-blank', title: 'Unassigned' }),
    );
  }

  function renderList() {
    if (t.tickets.length === 0) return emptyState();
    const groups = lanes(groupMode(), t.tickets);
    if (groups) {
      const folded = foldedLanes();
      return groups.map((lane) => {
        const group = el(
          'details',
          { class: 'list-group lane-group', 'data-lane': lane.key, open: folded.has(lane.key) ? null : true, ontoggle: (event) => setLaneFolded(lane.key, !event.target.open) },
          el(
            'summary',
            {},
            lane.emoji ? el('span', { 'aria-hidden': 'true', text: lane.emoji }) : null,
            el('span', { text: lane.label }),
            el('span', { class: 'muted small', text: `${lane.open} open` }),
          ),
          lane.tickets.length ? lane.tickets.map((ticket) => listRow(ticket, { grouped: true })) : el('p', { class: 'muted small lane-empty', text: 'Nothing here yet. Drag a ticket in.' }),
        );
        group.addEventListener('dragover', (event) => {
          if (!dragging) return;
          event.preventDefault();
          group.classList.add('drop-target');
        });
        group.addEventListener('dragleave', (event) => {
          if (!group.contains(event.relatedTarget)) group.classList.remove('drop-target');
        });
        group.addEventListener('drop', (event) => {
          event.preventDefault();
          group.classList.remove('drop-target');
          const ticket = dragging;
          dragging = null;
          if (!ticket) return;
          void api(`/tickets/${ticket.ref}`, { method: 'POST', body: lane.move })
            .then((result) => notify(result.warning))
            .catch((err) => notify(err.message))
            .finally(() => void refreshTickets());
        });
        return group;
      });
    }
    return t.plan.statuses.map((status) => {
      const tickets = t.tickets.filter((x) => x.status.id === status.id);
      if (tickets.length === 0) return null;
      return el(
        'details',
        { class: 'list-group', open: status.category === 'completed' || status.category === 'canceled' ? null : true },
        el('summary', {}, statusIcon(status.category), el('span', { text: status.name }), el('span', { class: 'muted small', text: String(tickets.length) })),
        tickets.map((ticket) => listRow(ticket)),
      );
    });
  }

  function emptyState() {
    const filtered = Object.values(t.filters).some(Boolean);
    return el(
      'div',
      { class: 'empty-state' },
      el('span', { class: 'empty-icon' }, icon('task')),
      el('h2', { text: filtered ? 'No tickets match' : `No tickets in ${t.project} yet` }),
      el('p', {
        class: 'muted',
        text: filtered
          ? 'Clear the filters to see everything.'
          : `File work as tickets (${t.plan.key}-1, ${t.plan.key}-2, …). Assign one to an agent and it starts a task for it.`,
      }),
      filtered ? null : el('button', { class: 'primary', type: 'button', text: 'New ticket', onclick: () => openNewTicket() }),
    );
  }

  /* Ticket details */

  async function openTicket(ref, { refresh = false, force = false } = {}) {
    if (!ref) return;
    if (refresh && (panel() !== 'ticket' || t.open !== ref || t.editing)) return;
    if (refresh && !force && typing($('panel-body'))) {
      t.pendingDetail = true;
      return;
    }
    t.pendingDetail = false;
    if (!refresh && t.open !== ref) {
      t.moreFields = false;
      t.adding = new Set();
    }
    if (!refresh) openPanel('ticket', ref);
    t.open = ref;
    let ticket;
    try {
      ticket = await api(`/tickets/${encodeURIComponent(ref)}`);
    } catch (err) {
      $('panel-body').replaceChildren(el('p', { class: 'error panel-intro', text: err.message }));
      return;
    }
    if (panel() !== 'ticket' || t.open !== ref) return;
    await planFor(ticket.project, refresh && t.replan);
    t.replan = false;
    if (panel() !== 'ticket' || t.open !== ref) return;
    renderDetail(ticket);
    // A ticket you open goes to Recent in the sidebar (#96).
    if (!refresh) ctx.onTicketOpen?.(ticket);
  }

  async function save(ticket, patch) {
    try {
      const result = await api(`/tickets/${ticket.ref}`, { method: 'POST', body: patch });
      renderDetail(result.ticket, result.warning);
    } catch (err) {
      notify(err.message);
      void openTicket(ticket.ref, { refresh: true, force: true });
    }
  }

  function renderDetail(ticket, warning) {
    t.openProject = ticket.project;
    const body = $('panel-body');
    const draft = body.querySelector('.comment-box textarea')?.value ?? '';
    $('panel-title').textContent = ticket.ref;
    const plan = plans.get(ticket.project);
    const change = (field, transform = (v) => v) => (value) => void save(ticket, { [field]: transform(value) });

    const title = el('textarea', { class: 'detail-title', rows: '1', 'aria-label': 'Title', maxlength: '200' });
    title.value = ticket.title;
    title.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        title.blur();
      }
    });
    title.addEventListener('blur', () => {
      if (title.value.trim() && title.value.trim() !== ticket.title) void save(ticket, { title: title.value });
    });

    const cycles = plan.cycles.filter((c) => !c.completedAt);
    if (ticket.cycle && !cycles.some((c) => c.id === ticket.cycle.id)) cycles.push({ number: ticket.cycle.number, name: `Cycle ${ticket.cycle.number}` });

    const labelPicker = el(
      'div',
      { class: 'label-picker' },
      plan.labels.length
        ? plan.labels.map((label) => {
            const on = ticket.labels.some((l) => l.id === label.id);
            const chip = labelChip(label);
            chip.classList.toggle('off', !on);
            return el(
              'button',
              {
                type: 'button',
                class: 'label-toggle',
                'aria-pressed': on ? 'true' : 'false',
                onclick: () => {
                  const names = ticket.labels.map((l) => l.name);
                  void save(ticket, { labels: on ? names.filter((n) => n !== label.name) : [...names, label.name] });
                },
              },
              chip,
            );
          })
        : el('span', { class: 'muted small', text: 'No labels yet. Add them in Settings.' }),
    );

    const field = (label, control) => el('div', { class: 'prop' }, el('span', { class: 'prop-label', text: label }), control);
    const estimate = el('input', { type: 'number', min: '0', max: '100', step: '1', value: ticket.estimate ?? null, placeholder: '–', 'aria-label': 'Estimate' });
    estimate.addEventListener('change', () => void save(ticket, { estimate: estimate.value === '' ? null : Number(estimate.value) }));
    const due = el('input', { type: 'date', value: ticket.dueDate ?? null, 'aria-label': 'Due date' });
    due.addEventListener('change', () => void save(ticket, { dueDate: due.value || null }));

    const optional = [
      ['Estimate', estimate, ticket.estimate !== null],
      ['Due', due, Boolean(ticket.dueDate)],
      ['Milestone', select(ticket.milestone?.name ?? '', [['', 'None'], ...plan.milestones.map((m) => [m.name, m.name])], change('milestone', (v) => v || null), { 'aria-label': 'Milestone' }), Boolean(ticket.milestone)],
      ['Cycle', select(ticket.cycle?.number ?? '', [['', 'None'], ...cycles.map((c) => [String(c.number), c.name])], change('cycle', (v) => (v ? Number(v) : null)), { 'aria-label': 'Cycle' }), Boolean(ticket.cycle)],
      ['Labels', labelPicker, ticket.labels.length > 0],
      plan.folders?.length
        ? [
            'Folder',
            select(ticket.folder?.name ?? '', [['', 'None'], ...plan.folders.map((f) => [f.name, f.emoji ? `${f.emoji} ${f.name}` : f.name])], change('folder', (v) => v || null), { 'aria-label': 'Folder' }),
            Boolean(ticket.folder),
          ]
        : null,
    ].filter(Boolean);
    const props = el(
      'div',
      { class: 'props' },
      field('Status', select(ticket.status.name, plan.statuses.map((s) => [s.name, s.name]), change('status'), { 'aria-label': 'Status' })),
      field('Priority', select(ticket.priority, PRIORITY_ORDER.map((p) => [p, PRIORITY_LABEL[p]]), change('priority'), { 'aria-label': 'Priority' })),
      field(
        'Assignee',
        select(
          ticket.assignee?.name ?? '',
          [['', 'Unassigned'], ...plan.members.filter((p) => p.kind === 'user').map((p) => [p.name, p.name]), ...plan.members.filter((p) => p.kind === 'agent').map((p) => [p.name, `${p.name} (agent)`])],
          change('assignee', (v) => v || null),
          { 'aria-label': 'Assignee' },
        ),
      ),
      // Fewer things to look at: the optional fields show only once set, the rest behind one link.
      ...optional.filter(([, , set]) => set || t.moreFields).map(([label, control]) => field(label, control)),
      optional.every(([, , set]) => set) || t.moreFields
        ? null
        : el('button', {
            class: 'link-button small more-fields',
            type: 'button',
            text: `+ ${optional.filter(([, , set]) => !set).map(([label]) => label.toLowerCase()).join(', ')}`,
            onclick: () => ((t.moreFields = true), renderDetail(ticket)),
          }),
    );

    const agentRow =
      ticket.assignee?.kind === 'agent'
        ? el(
            'div',
            { class: 'agent-row' },
            icon('bot'),
            ticket.task
              ? el('span', {}, taskBadge(ticket.task), ` · task #${ticket.task.id}`)
              : el('span', { class: 'muted', text: `No task yet for ${ticket.assignee.name}` }),
            el('span', { class: 'spacer' }),
            ticket.task ? el('button', { class: 'ghost small', type: 'button', text: 'View task', onclick: () => void viewTask(ticket.task.id) }) : null,
            !ticket.task || !OPEN_TASK.includes(ticket.task.state)
              ? el('button', {
                  class: 'small',
                  type: 'button',
                  text: ticket.task ? 'Start again' : 'Start task',
                  onclick: async () => {
                    try {
                      renderDetail((await api(`/tickets/${ticket.ref}/start`, { method: 'POST' })).ticket);
                    } catch (err) {
                      notify(err.message);
                    }
                  },
                })
              : null,
          )
        : null;

    body.replaceChildren(
      el(
        'div',
        { class: 'ticket-detail' },
        warning ? el('p', { class: 'notice', role: 'status', text: warning }) : null,
        ticket.parent ? el('button', { class: 'link-button small', type: 'button', text: `Sub-ticket of ${ticket.parent}`, onclick: () => void openTicket(ticket.parent) }) : null,
        title,
        nowBlock(ticket),
        props,
        // While its agent is on it, the status line at the bottom says so; the row is for starting one.
        workLine(ticket) ? null : agentRow,
        standingApprovals(ticket),
        sections(ticket),
        activityBlock(ticket, draft),
        workLine(ticket),
      ),
    );
    autosize(title);
  }

  /** Approvals still in force on the ticket (a standing "don't ask again" among them), each with Stop (#95). */
  function standingApprovals(ticket) {
    // Requests approved under a standing approval are covered by it: show the standing one only.
    const all = (ticket.approvals ?? []).filter((a) => a.inForce && a.validUntil);
    const standingKinds = new Set(all.filter((a) => a.standing).map((a) => a.actionKind?.toLowerCase()));
    const live = all.filter((a) => a.standing || !standingKinds.has(a.actionKind?.toLowerCase()));
    if (!live.length) return null;
    return el(
      'div',
      { class: 'standing-approvals' },
      live.map((a) =>
        el(
          'div',
          { class: 'standing-row small' },
          el('span', { class: 'standing-mark', 'aria-hidden': 'true', text: '✓' }),
          el('span', {
            text: a.standing
              ? `"${a.actionKind}" approved without asking until ${shortDate(a.validUntil.slice(0, 10))}`
              : `Approved until ${shortDate(a.validUntil.slice(0, 10))}: ${a.summary}`,
            title: a.summary,
          }),
          el('span', { class: 'spacer' }),
          me().kind === 'user'
            ? el('button', {
                class: 'ghost small',
                type: 'button',
                text: 'Stop',
                title: 'End it now; the next request asks again',
                onclick: () =>
                  void api(`/approvals/${a.id}/revoke`, { method: 'POST', body: {} })
                    .then(() => openTicket(ticket.ref, { refresh: true, force: true }))
                    .catch((err) => notify(err.message)),
              })
            : null,
        ),
      ),
    );
  }

  /**
   * The ticket's sections, only those with something in them (or that the person just chose to add),
   * and one quiet "Add" line for the rest: an empty ticket reads as a title, a next step and a few
   * fields, not a form.
   */
  function sections(ticket) {
    const adding = t.adding ?? (t.adding = new Set());
    const list = [
      ['handoff', 'handoff', Boolean(ticket.handoff), (editing) => handoffBlock(ticket, { editing })],
      ['description', 'description', Boolean(ticket.description), (editing) => descriptionBlock(ticket, { editing })],
      ['criteria', 'criteria', ticket.criteriaItems.length > 0, () => criteriaBlock(ticket)],
      [
        'links',
        'blocker',
        Boolean(ticket.blockers.length || ticket.blocking.length || ticket.blockedReason || ticket.closedAs || ticket.replaces?.length),
        () => linksBlock(ticket),
      ],
      ['children', 'sub-ticket', ticket.children.length > 0, () => childrenBlock(ticket)],
    ];
    const shown = list.filter(([key, , filled]) => filled || adding.has(key)).map(([key, , filled, make]) => make(!filled && adding.has(key)));
    const missing = list.filter(([key, , filled]) => !filled && !adding.has(key));
    const pick = (key) => {
      if (key === 'children') return openNewTicket({ parent: ticket.ref, project: ticket.project });
      adding.add(key);
      renderDetail(ticket);
      $('panel-body').querySelector(`[data-section="${key}"] input, [data-section="${key}"] textarea`)?.focus();
    };
    return [
      ...shown,
      missing.length
        ? el(
            'p',
            { class: 'detail-add small' },
            el('span', { class: 'muted', text: 'Add ' }),
            missing.flatMap(([key, label], i) => [i ? el('span', { class: 'muted', text: ' · ' }) : null, el('button', { class: 'link-button', type: 'button', text: label, onclick: () => pick(key) })]),
          )
        : null,
    ];
  }

  /**
   * The first lines of a ticket: its state, its one next step, and who it waits on (with one-tap
   * replies for that person), so nobody has to scroll to know what happens now.
   */
  function nowBlock(ticket) {
    const open = !['completed', 'canceled'].includes(ticket.status.category);
    const people = (plans.get(ticket.project)?.members ?? []);
    const wrap = el('section', { class: 'detail-now' });
    const view = () => {
      const w = ticket.waitingOn;
      const mine = w && w.person === me()?.name;
      const reply = (text) =>
        void api(`/tickets/${ticket.ref}/waiting`, { method: 'POST', body: { reply: text } })
          .then((updated) => renderDetail(updated))
          .catch((err) => notify(err.message));
      const line = el('input', { class: 'answer-input', placeholder: 'Or reply in a line', 'aria-label': 'Reply', maxlength: '140' });
      line.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' && line.value.trim()) reply(line.value.trim());
      });
      wrap.replaceChildren(
        ...[
        stateLine(ticket),
        open
          ? el(
              'div',
              { class: 'now-row' },
              el('strong', { text: 'Next:' }),
              el('span', { class: ticket.nextStep ? '' : 'muted', text: ticket.nextStep ? `${ticket.nextStep.text}${ticket.nextStep.for ? ` (${ticket.nextStep.for})` : ''}` : 'No next step' }),
              el('button', { class: 'ghost small', type: 'button', text: ticket.nextStep ? 'Edit' : 'Add', onclick: editNext }),
              w ? null : el('button', { class: 'ghost small', type: 'button', text: 'Ask someone', title: 'Need someone to do something? Ask them here; it shows in their Needs you', onclick: editWaiting }),
            )
          : null,
        w
          ? el(
              'div',
              { class: 'now-row' },
              el('strong', { text: `Waiting on ${mine ? 'you' : w.person}:` }),
              el('span', { text: w.ask }),
              mine
                ? el(
                    'span',
                    { class: 'now-actions' },
                    (w.options?.length ? w.options : ['Done']).map((option, _i, all) =>
                      el('button', { class: all.length === 1 ? 'primary small' : 'small', type: 'button', text: option, onclick: () => reply(option) }),
                    ),
                    el('button', { class: 'ghost small', type: 'button', text: 'Not yet', onclick: () => reply('not_yet') }),
                    line,
                  )
                : el('button', { class: 'ghost small', type: 'button', text: 'Clear', onclick: () => void save(ticket, { waitingOn: null }) }),
            )
          : null,
        ].filter(Boolean),
      );
    };
    const editNext = () => {
      const text = el('input', { maxlength: '140', 'aria-label': 'Next step', placeholder: 'The one next thing to do', value: ticket.nextStep?.text ?? '' });
      const who = select(ticket.nextStep?.for ?? '', [['', 'Anyone'], ...people.map((p) => [p.name, p.name])], () => {}, { 'aria-label': 'For' });
      wrap.replaceChildren(
        el('div', { class: 'now-row' }, el('strong', { text: 'Next:' }), text, who),
        el('div', { class: 'row-end' }, el('button', { class: 'ghost small', type: 'button', text: 'Cancel', onclick: view }), el('button', { class: 'primary small', type: 'button', text: 'Save', onclick: () => void save(ticket, { nextStep: text.value, nextStepFor: who.value || null }) })),
      );
      text.focus();
    };
    const editWaiting = () => {
      const who = select('', [['', 'Who?'], ...people.filter((p) => p.kind === 'user').map((p) => [p.name, p.name])], () => {}, { 'aria-label': 'Waiting on' });
      const ask = el('input', { maxlength: '140', 'aria-label': 'What you need', placeholder: 'What you need, in a line (a question gets Yes / No)' });
      wrap.replaceChildren(
        el('div', { class: 'now-row' }, el('strong', { text: 'Waiting on' }), who, ask),
        el('div', { class: 'row-end' }, el('button', { class: 'ghost small', type: 'button', text: 'Cancel', onclick: view }), el('button', { class: 'primary small', type: 'button', text: 'Ask', onclick: () => who.value && void save(ticket, { waitingOn: who.value, waitingAsk: ask.value }) })),
      );
    };
    view();
    return wrap;
  }

  /** Long text folds to its first lines with "Show more"; short text shows as it is. */
  function folded(text, { lines = 8, firstLineOnly = false, headline = false } = {}) {
    const count = String(text ?? '').split('\n').length;
    const long = firstLineOnly ? count > 1 || text.length > 160 : count > lines || text.length > lines * 120;
    const body = el('div', { class: 'md ticket-text' }, richText(text, { headline }));
    if (!long) return body;
    const preview = firstLineOnly
      ? el('div', { class: 'ticket-text first-line', text: text.trim().split('\n')[0].slice(0, 200) })
      : null;
    if (!firstLineOnly) body.classList.add('clamped');
    else body.hidden = true;
    const more = el('button', {
      class: 'link-button small',
      type: 'button',
      text: `Show more (${count} line${count === 1 ? '' : 's'})`,
      onclick: () => {
        const open = more.dataset.open !== '1';
        more.dataset.open = open ? '1' : '0';
        if (firstLineOnly) {
          body.hidden = !open;
          if (preview) preview.hidden = open;
        } else body.classList.toggle('clamped', !open);
        more.textContent = open ? 'Show less' : `Show more (${count} line${count === 1 ? '' : 's'})`;
      },
    });
    return el('div', { class: 'foldable' }, preview, body, more);
  }

  function autosize(textarea) {
    textarea.style.height = 'auto';
    textarea.style.height = `${textarea.scrollHeight}px`;
    textarea.addEventListener('input', () => {
      textarea.style.height = 'auto';
      textarea.style.height = `${textarea.scrollHeight}px`;
    });
  }

  function handoffBlock(ticket, { editing = false } = {}) {
    const wrap = el('section', { class: 'detail-section', 'data-section': 'handoff' });
    const view = () => {
      t.editing = false;
      const h = ticket.handoff;
      wrap.replaceChildren(
        el(
          'div',
          { class: 'section-head' },
          el('h3', { text: 'Handoff' }),
          h ? el('span', { class: 'muted small section-meta', text: `${h.by ?? 'Someone'} · ${ago(h.at)}` }) : null,
          el('span', { class: 'spacer' }),
          el('button', { class: 'ghost small', type: 'button', text: h ? 'Edit' : 'Add', onclick: edit }),
        ),
        h ? folded(h.text, { headline: true }) : el('p', { class: 'muted small', text: 'Where the work stands, for whoever picks it up next. Agents keep this current.' }),
      );
    };
    const edit = () => {
      t.editing = true;
      const area = el('textarea', { rows: '5', 'aria-label': 'Handoff note', placeholder: 'Done: … Next: … Branch or PR: … Watch out for: …' });
      area.value = ticket.handoff?.text ?? '';
      wrap.replaceChildren(
        el('div', { class: 'section-head' }, el('h3', { text: 'Handoff' })),
        area,
        el(
          'div',
          { class: 'row-end' },
          el('button', { class: 'ghost small', type: 'button', text: 'Cancel', onclick: view }),
          el('button', {
            class: 'primary small',
            type: 'button',
            text: 'Save',
            onclick: () => {
              t.editing = false;
              void save(ticket, { handoff: area.value });
            },
          }),
        ),
      );
      area.focus();
    };
    if (editing) edit();
    else view();
    return wrap;
  }

  function criteriaBlock(ticket) {
    const items = ticket.criteriaItems;
    const add = el('input', { placeholder: 'Add a criterion, like “Tests pass”', 'aria-label': 'New criterion', maxlength: '300' });
    add.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && add.value.trim()) {
        event.preventDefault();
        void save(ticket, { criteriaAdd: [add.value] });
      }
    });
    const done = items.filter((c) => c.done).length;
    return el(
      'section',
      { class: 'detail-section', 'data-section': 'criteria' },
      el('div', { class: 'section-head' }, el('h3', { text: `Acceptance criteria${items.length ? ` · ${done}/${items.length}` : ''}` })),
      el(
        'ul',
        { class: 'criteria' },
        items.map((c) => {
          const box = el('input', { type: 'checkbox', checked: c.done ? true : null, 'aria-label': c.text });
          box.addEventListener('change', () => void save(ticket, box.checked ? { criteriaDone: [c.id] } : { criteriaUndone: [c.id] }));
          return el(
            'li',
            { class: c.done ? 'done' : null },
            el('label', {}, box, el('span', { text: c.text })),
            me().kind === 'user'
              ? el('button', { class: 'ghost icon', type: 'button', 'aria-label': `Remove “${c.text}”`, onclick: () => void save(ticket, { criteriaRemove: [c.id] }) }, icon('x'))
              : null,
          );
        }),
      ),
      add,
    );
  }

  function linksBlock(ticket) {
    const add = el('input', { placeholder: 'Blocked by… (a key like ORC-4)', 'aria-label': 'Add a blocker', maxlength: '24' });
    add.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && add.value.trim()) {
        event.preventDefault();
        void save(ticket, { blockedByAdd: [add.value.trim().toUpperCase()] });
      }
    });
    // A linked ticket in a project you cannot see comes as "(hidden)": nothing to open or remove.
    const row = (link, remove) => {
      const hidden = link.ref === '(hidden)';
      return el(
        'div',
        { class: 'child-row link-row' },
        statusIcon(link.category),
        hidden ? el('span', { class: 'ticket-ref link-ref muted', text: 'hidden' }) : el('button', { class: 'ticket-ref link-ref', type: 'button', text: link.ref, onclick: () => void openTicket(link.ref) }),
        el('span', { class: 'list-title', text: link.title }),
        remove && !hidden ? el('button', { class: 'ghost icon', type: 'button', 'aria-label': `Remove blocker ${link.ref}`, onclick: remove }, icon('x')) : null,
      );
    };
    const open = ticket.blockedBy.length + (ticket.blockedReason ? 1 : 0);
    const reason = el('input', {
      value: ticket.blockedReason ?? null,
      placeholder: 'Blocked outside the project? Say on what, like “waiting on the vendor”',
      'aria-label': 'Blocked on something outside the project',
      maxlength: '200',
    });
    const saveReason = () => {
      if (reason.value.trim() !== (ticket.blockedReason ?? '')) void save(ticket, { blockedReason: reason.value });
    };
    reason.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        saveReason();
      }
    });
    reason.addEventListener('change', saveReason);
    return el(
      'section',
      { class: 'detail-section', 'data-section': 'links' },
      el(
        'div',
        { class: 'section-head' },
        el('h3', { text: 'Dependencies' }),
        open ? el('span', { class: 'meta-pill blocked', title: blockedWhy(ticket), text: 'Blocked' }) : null,
        el('span', { class: 'spacer' }),
      ),
      ticket.closedAs ? el('p', { class: 'muted small link-label', text: ticket.closedAs.reason === 'duplicate' ? 'Duplicate of' : 'Superseded by' }) : null,
      ticket.closedAs ? row(ticket.closedAs.ticket, null) : null,
      ticket.replaces?.length ? el('p', { class: 'muted small link-label', text: 'Replaces' }) : null,
      (ticket.replaces ?? []).map((r) => row(r, null)),
      ticket.blockers.length ? el('p', { class: 'muted small link-label', text: 'Blocked by' }) : null,
      ticket.blockers.map((b) => row(b, () => void save(ticket, { blockedByRemove: [b.ref] }))),
      ticket.blocking.length ? el('p', { class: 'muted small link-label', text: 'Blocking' }) : null,
      ticket.blocking.map((b) => row(b, null)),
      // The two inputs stay folded behind one link unless there is a reason to show or the person
      // just chose to add a blocker.
      ticket.blockedReason || t.adding?.has('links-open') || !(ticket.blockers.length || ticket.blocking.length || ticket.closedAs || ticket.replaces?.length)
        ? [reason, add]
        : el('button', {
            class: 'link-button small more-fields',
            type: 'button',
            text: '+ Add a blocker',
            onclick: () => {
              (t.adding ?? (t.adding = new Set())).add('links-open');
              renderDetail(ticket);
              $('panel-body').querySelector('[data-section="links"] input')?.focus();
            },
          }),
    );
  }

  function descriptionBlock(ticket, { editing = false } = {}) {
    const wrap = el('section', { class: 'detail-section', 'data-section': 'description' });
    const view = () => {
      t.editing = false;
      wrap.replaceChildren(
        el('div', { class: 'section-head' }, el('h3', { text: 'Description' }), el('button', { class: 'ghost small', type: 'button', text: 'Edit', onclick: edit })),
        ticket.description ? folded(ticket.description) : el('p', { class: 'muted small', text: 'No description.' }),
      );
    };
    const edit = () => {
      t.editing = true;
      const area = el('textarea', { rows: '8', 'aria-label': 'Description', placeholder: 'Markdown: context, acceptance criteria, links' });
      area.value = ticket.description;
      wrap.replaceChildren(
        el('div', { class: 'section-head' }, el('h3', { text: 'Description' })),
        area,
        el(
          'div',
          { class: 'row-end' },
          el('button', { class: 'ghost small', type: 'button', text: 'Cancel', onclick: view }),
          el('button', {
            class: 'primary small',
            type: 'button',
            text: 'Save',
            onclick: () => {
              t.editing = false;
              void save(ticket, { description: area.value });
            },
          }),
        ),
      );
      area.focus();
    };
    if (editing) edit();
    else view();
    return wrap;
  }

  function childrenBlock(ticket) {
    return el(
      'section',
      { class: 'detail-section', 'data-section': 'children' },
      el(
        'div',
        { class: 'section-head' },
        el('h3', { text: `Sub-tickets${ticket.children.length ? ` · ${ticket.children.filter((c) => c.status.category === 'completed').length}/${ticket.children.length}` : ''}` }),
        el('button', { class: 'ghost small', type: 'button', text: 'Add', onclick: () => openNewTicket({ parent: ticket.ref, project: ticket.project }) }),
      ),
      ticket.children.map((child) =>
        el(
          'button',
          { class: 'child-row', type: 'button', onclick: () => void openTicket(child.ref) },
          statusIcon(child.status.category),
          el('span', { class: 'ticket-ref', text: child.ref }),
          el('span', { class: 'list-title', text: child.title }),
          child.assignee ? avatar(child.assignee.name, child.assignee.kind) : null,
        ),
      ),
    );
  }

  function describeChange(c) {
    const v = (x) => (x === null || x === undefined || (Array.isArray(x) && x.length === 0) ? null : Array.isArray(x) ? x.join(', ') : String(x));
    switch (c.field) {
      case 'status':
        return `moved it from ${c.from} to ${c.to}`;
      case 'assignee':
        return c.to ? `assigned it to ${c.to}` : 'unassigned it';
      case 'priority':
        return `set priority to ${PRIORITY_LABEL[c.to].toLowerCase()}`;
      case 'title':
        return `renamed it to “${c.to}”`;
      case 'description':
        return c.to === '(cleared)' ? 'cleared the description' : 'edited the description';
      case 'nextStep':
        return c.to ? `set the next step: ${c.to}` : 'cleared the next step';
      case 'waitingOn':
        return c.to ? `asked ${c.to}` : `stopped waiting on ${c.from}`;
      case 'unblocked':
        return c.from === '(hidden)' ? 'is no longer blocked' : `is no longer blocked: ${c.from} is ${c.to}`;
      case 'closedAs':
        return `closed it as ${c.to}`;
      case 'replaces':
        return `closed ${c.to.replace(/ \((duplicate|superseded)\)$/, (_, why) => (why === 'duplicate' ? ' as a duplicate of this' : ' as superseded by this'))}`;
      case 'estimate':
        return v(c.to) ? `set the estimate to ${c.to} pt` : 'cleared the estimate';
      case 'dueDate':
        return v(c.to) ? `set the due date to ${shortDate(c.to)}` : 'cleared the due date';
      case 'labels':
        return v(c.to) ? `set labels to ${v(c.to)}` : 'removed all labels';
      case 'milestone':
        return v(c.to) ? `moved it to milestone ${c.to}` : 'removed it from its milestone';
      case 'cycle':
        return v(c.to) ? `moved it to Cycle ${c.to}` : 'took it out of its cycle';
      case 'folder':
        return v(c.to) ? `moved it to the ${c.to} folder` : 'took it out of its folder';
      case 'parent':
        return v(c.to) ? `made it a sub-ticket of ${c.to}` : 'made it a top-level ticket';
      case 'handoff':
        return c.to === '(cleared)' ? 'cleared the handoff note' : 'updated the handoff note';
      case 'criteria': {
        const parts = [];
        if (c.to.added.length) parts.push(`added ${c.to.added.length === 1 ? `“${c.to.added[0]}”` : `${c.to.added.length} criteria`}`);
        if (c.to.done.length) parts.push(`met ${c.to.done.map((x) => `“${x}”`).join(', ')}`);
        if (c.to.undone.length) parts.push(`reopened ${c.to.undone.map((x) => `“${x}”`).join(', ')}`);
        if (c.to.removed.length) parts.push(`removed ${c.to.removed.map((x) => `“${x}”`).join(', ')}`);
        return parts.join(', ') || 'edited the criteria';
      }
      case 'blockedReason':
        return c.to ? `marked it blocked: ${c.to}` : 'cleared the outside blocker';
      case 'blockedBy': {
        const parts = [];
        if (c.to.length) parts.push(`marked it blocked by ${c.to.join(', ')}`);
        if (c.from.length) parts.push(`removed blocker ${c.from.join(', ')}`);
        return parts.join(', ');
      }
      default:
        return `changed ${c.field}`;
    }
  }

  function activityBlock(ticket, draft) {
    // People's words stand out and show in full; agents' fold to their first line (#84).
    const peopleOnly = peopleOnlyOn();
    const entries = peopleOnly ? ticket.activity.filter((a) => a.kind === 'comment' && a.actorKind === 'user') : ticket.activity;
    const items = entries.map((a) => {
      const who = a.actor ?? 'Orco';
      if (a.kind === 'comment') {
        const person = a.actorKind === 'user';
        return el(
          'li',
          { class: `activity-comment ${person ? 'by-person' : 'by-agent'}` },
          avatar(who, a.actorKind),
          el(
            'div',
            { class: 'comment-main' },
            el('div', { class: 'comment-head' }, el('strong', { text: who }), el('span', { class: `who-chip ${person ? 'person' : 'agent'}`, text: person ? 'Person' : a.actorKind === 'agent' ? 'Agent' : 'Orco' }), el('span', { class: 'muted small', text: ago(a.createdAt) })),
            person ? el('div', { class: 'md ticket-text' }, richText(a.body, { headline: true })) : folded(a.body, { firstLineOnly: true, headline: true }),
          ),
        );
      }
      let text;
      if (a.kind === 'created') text = 'created the ticket';
      else if (a.kind === 'change') text = a.detail.changes.map(describeChange).join(', ');
      else {
        const d = a.detail ?? {};
        text = d.taskId ? TASK_EVENT[d.state]?.(d) ?? `updated task #${d.taskId}` : `could not start a task for ${d.agent}`;
      }
      return el(
        'li',
        { class: 'activity-event' },
        el('span', { class: 'activity-dot', 'aria-hidden': 'true' }),
        el('span', {}, a.actor ? [el('strong', { text: who }), ` ${text}`] : `${text[0].toUpperCase()}${text.slice(1)}`, a.kind === 'task' && a.body ? el('span', { class: 'activity-note', text: ` — ${a.body}` }) : null, el('span', { class: 'muted small', text: ` · ${ago(a.createdAt)}` })),
      );
    });
    const box = el('textarea', { rows: '2', placeholder: 'Leave a comment, or / for commands', 'aria-label': 'Comment' });
    box.value = draft;
    const send = async () => {
      if (!box.value.trim()) return;
      // A slash command acts on this ticket instead of posting (#93): /next "call Michael".
      const command = parseCommand(box.value);
      if (command && command.name !== 'task') {
        try {
          await ctx.runCommand(command, { ticket: ticket.ref, project: ticket.project });
          box.value = '';
        } catch (err) {
          notify(err.message);
        }
        return;
      }
      try {
        const updated = await api(`/tickets/${ticket.ref}/comments`, { method: 'POST', body: { text: box.value } });
        box.value = '';
        renderDetail(updated);
      } catch (err) {
        notify(err.message);
      }
    };
    box.addEventListener('keydown', (event) => {
      // A command is one line, so Enter runs it; a comment sends with Ctrl+Enter.
      if (event.key === 'Enter' && (event.metaKey || event.ctrlKey || (!event.shiftKey && parseCommand(box.value)))) {
        event.preventDefault();
        void send();
      }
    });
    const commentBox = el('div', { class: 'comment-box' }, box, el('div', { class: 'row-end' }, el('button', { class: 'primary small', type: 'button', text: 'Comment', onclick: () => void send() })));
    ctx.attachCommands?.(box, 'ticket');
    ctx.attachTicketRefs?.(box);
    return el(
      'section',
      { class: 'detail-section' },
      el(
        'div',
        { class: 'section-head' },
        el('h3', { text: 'Activity' }),
        el('span', { class: 'spacer' }),
        el('label', { class: 'check small' }, el('input', { type: 'checkbox', checked: peopleOnly, onchange: (event) => (setPeopleOnly(event.target.checked), renderDetail(ticket)) }), 'People only'),
      ),
      el('ol', { class: 'activity' }, foldRuns(items, entries)),
      commentBox,
      el('p', { class: 'muted small detail-foot', text: `Opened by ${ticket.creator} ${ago(ticket.createdAt)} · updated ${ago(ticket.updatedAt)}` }),
    );
  }

  const PEOPLE_KEY = 'orco.activityPeopleOnly';
  function peopleOnlyOn() {
    try {
      return localStorage.getItem(PEOPLE_KEY) === '1';
    } catch {
      return false;
    }
  }
  function setPeopleOnly(on) {
    try {
      localStorage.setItem(PEOPLE_KEY, on ? '1' : '0');
    } catch {
      // Private windows: it applies to this view only.
    }
  }

  /** Three or more field changes in a row fold into one "N changes" line. */
  function foldRuns(items, entries) {
    const out = [];
    for (let i = 0; i < items.length; ) {
      let j = i;
      while (j < items.length && entries[j].kind !== 'comment') j++;
      if (j - i >= 3) {
        const run = items.slice(i, j);
        out.push(el('li', { class: 'activity-event' }, el('details', { class: 'activity-run' }, el('summary', { class: 'small', text: `${run.length} changes` }), el('ol', { class: 'activity' }, run))));
        i = j;
      } else if (j > i) {
        out.push(...items.slice(i, j));
        i = j;
      } else {
        out.push(items[i]);
        i++;
      }
    }
    return out;
  }

  async function viewTask(id) {
    try {
      const task = await api(`/tasks/${id}`);
      await jumpTo({ id: task.messageId, room: task.room, threadId: null });
    } catch (err) {
      notify(err.message);
    }
  }

  /* New ticket */

  async function openNewTicket(defaults = {}) {
    const project = defaults.project ?? t.project;
    const plan = await planFor(project);
    openPanel('new-ticket', `New ${plan.key} ticket`);
    t.open = null;
    const title = el('input', { name: 'title', required: true, maxlength: '200', placeholder: 'Title', 'aria-label': 'Title', autocomplete: 'off' });
    const description = el('textarea', { name: 'description', rows: '5', placeholder: 'Description (Markdown)', 'aria-label': 'Description' });
    const fields = {
      status: select(defaults.status ?? plan.statuses.find((s) => s.category === 'backlog' || s.category === 'unstarted')?.name, plan.statuses.map((s) => [s.name, s.name]), () => {}, { 'aria-label': 'Status' }),
      priority: select('none', PRIORITY_ORDER.map((p) => [p, PRIORITY_LABEL[p]]), () => {}, { 'aria-label': 'Priority' }),
      assignee: select(
        '',
        [['', 'Unassigned'], ...plan.members.filter((p) => p.kind === 'user').map((p) => [p.name, p.name]), ...plan.members.filter((p) => p.kind === 'agent').map((p) => [p.name, `${p.name} (agent)`])],
        () => {},
        { 'aria-label': 'Assignee' },
      ),
      milestone: select(defaults.milestone ?? '', [['', 'No milestone'], ...plan.milestones.map((m) => [m.name, m.name])], () => {}, { 'aria-label': 'Milestone' }),
      cycle: select(defaults.cycle ?? '', [['', 'No cycle'], ...plan.cycles.filter((c) => !c.completedAt).map((c) => [String(c.number), c.current ? `${c.name} (current)` : c.name])], () => {}, { 'aria-label': 'Cycle' }),
      // New work goes into the folder on screen unless someone picks another.
      folder: plan.folders?.length
        ? select(
            defaults.folder ?? (project === t.project && t.filters.folder && t.filters.folder !== 'none' ? t.filters.folder : ''),
            [['', 'No folder'], ...plan.folders.map((f) => [f.name, f.emoji ? `${f.emoji} ${f.name}` : f.name])],
            () => {},
            { 'aria-label': 'Folder' },
          )
        : null,
    };
    const estimate = el('input', { type: 'number', min: '0', max: '100', step: '1', placeholder: 'Points', 'aria-label': 'Estimate' });
    const chosen = new Set();
    const labels = plan.labels.map((label) => {
      const chip = labelChip(label);
      chip.classList.add('off');
      return el(
        'button',
        {
          type: 'button',
          class: 'label-toggle',
          'aria-pressed': 'false',
          onclick: (event) => {
            const on = !chosen.has(label.name);
            if (on) chosen.add(label.name);
            else chosen.delete(label.name);
            chip.classList.toggle('off', !on);
            event.currentTarget.setAttribute('aria-pressed', String(on));
          },
        },
        chip,
      );
    });
    const error = el('p', { class: 'error', role: 'alert', hidden: true });
    const form = el(
      'form',
      {
        class: 'new-ticket',
        onsubmit: async (event) => {
          event.preventDefault();
          const body = {
            title: title.value,
            description: description.value,
            status: fields.status.value,
            priority: fields.priority.value,
            assignee: fields.assignee.value || null,
            milestone: fields.milestone.value || null,
            cycle: fields.cycle.value ? Number(fields.cycle.value) : null,
            estimate: estimate.value === '' ? null : Number(estimate.value),
            labels: [...chosen],
            folder: fields.folder?.value || null,
            parent: defaults.parent ?? null,
          };
          try {
            const result = await api(`/projects/${encodeURIComponent(project)}/tickets`, { method: 'POST', body });
            openPanel('ticket', result.ticket.ref);
            t.open = result.ticket.ref;
            renderDetail(result.ticket, result.warning);
          } catch (err) {
            error.textContent = err.message;
            error.hidden = false;
          }
        },
      },
      defaults.parent ? el('p', { class: 'muted small', text: `Sub-ticket of ${defaults.parent}` }) : null,
      title,
      description,
      el('div', { class: 'new-ticket-grid' }, fields.status, fields.priority, fields.assignee, estimate, fields.milestone, fields.cycle, fields.folder),
      labels.length ? el('div', { class: 'label-picker' }, labels) : null,
      el('p', { class: 'muted small', text: 'Assigning an agent starts a task for it right away.' }),
      error,
      el('div', { class: 'row-end' }, el('button', { class: 'ghost', type: 'button', text: 'Cancel', onclick: closePanel }), el('button', { class: 'primary', type: 'submit', text: 'Create ticket' })),
    );
    $('panel-body').replaceChildren(form);
    title.focus();
  }

  /* Milestones */

  function renderMilestones() {
    const name = el('input', { placeholder: 'Milestone name, like Beta', required: true, maxlength: '80', 'aria-label': 'Milestone name' });
    const date = el('input', { type: 'date', 'aria-label': 'Target date' });
    const form = el(
      'form',
      {
        class: 'inline-form',
        onsubmit: (event) => {
          event.preventDefault();
          void act(() => api(`/projects/${encodeURIComponent(t.project)}/milestones`, { method: 'POST', body: { name: name.value, targetDate: date.value || null } }));
        },
      },
      name,
      date,
      el('button', { class: 'primary small', type: 'submit', text: 'Add milestone' }),
    );
    const cards = t.plan.milestones.map((m) => {
      const overdue = m.targetDate && m.targetDate < today() && m.progress.completed < m.progress.tickets;
      return el(
        'article',
        { class: 'plan-card' },
        el(
          'div',
          { class: 'plan-card-head' },
          el('h3', { text: m.name }),
          m.targetDate ? el('span', { class: `meta-pill${overdue ? ' overdue' : ''}`, text: `Target ${shortDate(m.targetDate)}` }) : null,
          el('span', { class: 'spacer' }),
          el('button', { class: 'ghost small', type: 'button', text: 'View tickets', onclick: () => viewFiltered({ milestone: m.name }) }),
          el('button', { class: 'ghost small', type: 'button', text: 'Edit', onclick: (event) => editMilestone(m, event.currentTarget.closest('.plan-card')) }),
        ),
        m.description ? el('p', { class: 'muted small', text: m.description }) : null,
        progressBar(m.progress),
      );
    });
    return [
      me().kind === 'user' ? form : null,
      cards.length ? cards : el('p', { class: 'muted plan-intro', text: 'No milestones yet.' }),
    ];
  }

  function editMilestone(m, cardNode) {
    const name = el('input', { value: m.name, maxlength: '80', 'aria-label': 'Milestone name' });
    const date = el('input', { type: 'date', value: m.targetDate ?? null, 'aria-label': 'Target date' });
    const description = el('textarea', { rows: '2', placeholder: 'What does done look like?', 'aria-label': 'Description' });
    description.value = m.description;
    cardNode.replaceChildren(
      el(
        'form',
        {
          class: 'plan-edit',
          onsubmit: (event) => {
            event.preventDefault();
            void act(() =>
              api(`/projects/${encodeURIComponent(t.project)}/milestones/${m.id}`, {
                method: 'POST',
                body: { name: name.value, targetDate: date.value || null, description: description.value },
              }),
            );
          },
        },
        el('div', { class: 'inline-form' }, name, date),
        description,
        el(
          'div',
          { class: 'row-end' },
          el('button', {
            class: 'ghost small danger',
            type: 'button',
            text: 'Delete',
            onclick: () => {
              if (confirm(`Delete milestone ${m.name}? Its tickets stay, without a milestone.`)) {
                void act(() => api(`/projects/${encodeURIComponent(t.project)}/milestones/${m.id}`, { method: 'DELETE' }));
              }
            },
          }),
          el('span', { class: 'spacer' }),
          el('button', { class: 'ghost small', type: 'button', text: 'Cancel', onclick: renderTab }),
          el('button', { class: 'primary small', type: 'submit', text: 'Save' }),
        ),
      ),
    );
    name.focus();
  }

  /* Cycles */

  function renderCycles() {
    const cycles = t.plan.cycles;
    const now = today();
    const last = cycles.at(-1);
    const start = el('input', { type: 'date', 'aria-label': 'Starts on' });
    const end = el('input', { type: 'date', 'aria-label': 'Ends on' });
    const form = el(
      'form',
      {
        class: 'inline-form',
        onsubmit: (event) => {
          event.preventDefault();
          void act(() =>
            api(`/projects/${encodeURIComponent(t.project)}/cycles`, { method: 'POST', body: { startsOn: start.value || undefined, endsOn: end.value || undefined } }),
          );
        },
      },
      el('label', { class: 'muted small', text: 'Start' }),
      start,
      el('label', { class: 'muted small', text: 'End' }),
      end,
      el('button', { class: 'primary small', type: 'submit', text: `Add Cycle ${(last?.number ?? 0) + 1}` }),
    );
    const cardFor = (c) => {
      const status = c.completedAt ? 'Completed' : c.current ? 'Current' : c.startsOn > now ? 'Upcoming' : 'Ended';
      return el(
        'article',
        { class: `plan-card${c.current ? ' current' : ''}` },
        el(
          'div',
          { class: 'plan-card-head' },
          el('h3', { text: c.name }),
          el('span', { class: `meta-pill cycle-${status.toLowerCase()}`, text: status }),
          el('span', { class: 'muted small', text: `${shortDate(c.startsOn)} – ${shortDate(c.endsOn)}` }),
          el('span', { class: 'spacer' }),
          el('button', { class: 'ghost small', type: 'button', text: 'View tickets', onclick: () => viewFiltered({ cycle: String(c.number) }) }),
          !c.completedAt && c.startsOn <= now && me().kind === 'user'
            ? el('button', {
                class: 'small',
                type: 'button',
                text: 'Complete',
                onclick: () => {
                  if (!confirm(`Complete ${c.name}? Unfinished tickets move to the next cycle.`)) return;
                  void act(async () => {
                    const result = await api(`/projects/${encodeURIComponent(t.project)}/cycles/${c.id}/complete`, { method: 'POST' });
                    notify(
                      result.moved
                        ? `${result.moved} unfinished ${result.moved === 1 ? 'ticket' : 'tickets'} moved to ${result.movedTo ? `Cycle ${result.movedTo}` : 'no cycle (add the next one)'}.`
                        : `${c.name} is complete.`,
                    );
                  });
                },
              })
            : null,
        ),
        progressBar(c.progress),
      );
    };
    const active = cycles.filter((c) => !c.completedAt);
    const done = cycles.filter((c) => c.completedAt).reverse();
    return [
      me().kind === 'user' ? form : null,
      active.length ? active.map(cardFor) : el('p', { class: 'muted plan-intro', text: 'No upcoming cycles.' }),
      done.length ? el('details', { class: 'list-group' }, el('summary', { text: `Completed · ${done.length}` }), done.map(cardFor)) : null,
    ];
  }

  function viewFiltered(filters) {
    t.filters = { ...EMPTY_FILTERS, ...filters };
    location.hash = `#~${t.project}/list`;
  }

  /* Notes */

  function noteForm(note, onCancel) {
    const title = el('input', { value: note?.title ?? null, placeholder: 'Title, like “Deploying”', maxlength: '80', required: true, 'aria-label': 'Note title' });
    const body = el('textarea', { rows: '6', placeholder: 'Markdown. Durable facts the next person or agent needs.', required: true, 'aria-label': 'Note' });
    body.value = note?.body ?? '';
    return el(
      'form',
      {
        class: 'note-form',
        onsubmit: (event) => {
          event.preventDefault();
          void act(() => api(`/projects/${encodeURIComponent(t.project)}/notes`, { method: 'POST', body: { id: note?.id, title: title.value, body: body.value } }));
        },
      },
      title,
      body,
      el(
        'div',
        { class: 'row-end' },
        onCancel ? el('button', { class: 'ghost small', type: 'button', text: 'Cancel', onclick: onCancel }) : null,
        el('button', { class: 'primary small', type: 'submit', text: note ? 'Save' : 'Add note' }),
      ),
    );
  }

  function renderNotes() {
    const notes = t.notes ?? [];
    const cards = notes.map((note) => {
      const card = el(
        'article',
        { class: 'plan-card note-card' },
        el(
          'div',
          { class: 'plan-card-head' },
          el('h3', { text: note.title }),
          el('span', { class: 'muted small', text: `${note.updatedBy} · ${ago(note.updatedAt)}` }),
          el('span', { class: 'spacer' }),
          el('button', { class: 'ghost small', type: 'button', text: 'Edit', onclick: () => card.replaceChildren(noteForm(note, renderTab)) }),
          me().kind === 'user'
            ? el('button', {
                class: 'ghost small danger',
                type: 'button',
                text: 'Delete',
                onclick: () => {
                  if (confirm(`Delete the note “${note.title}”?`)) void act(() => api(`/projects/${encodeURIComponent(t.project)}/notes/${note.id}`, { method: 'DELETE' }));
                },
              })
            : null,
        ),
        el('div', { class: 'md ticket-text' }, richText(note.body)),
      );
      return card;
    });
    const add = el('div', { class: 'notes-new' });
    const closed = () =>
      add.replaceChildren(
        el('button', { class: 'primary small', type: 'button', onclick: () => add.replaceChildren(noteForm(null, closed)) }, icon('plus'), 'New note'),
        el('span', { class: 'muted small', text: 'Short, durable facts for whoever works here next. Agents read these first.' }),
      );
    closed();
    return [
      add,
      cards.length ? cards : el('p', { class: 'muted plan-intro', text: 'No notes yet.' }),
    ];
  }

  function onNotes() {
    if (t.tab !== 'notes' || !root || root.hidden) return;
    clearTimeout(t.timer);
    t.timer = setTimeout(() => void load(), 250);
  }

  /* Files */

  function fileEditor(file, onCancel) {
    const path = el('input', { value: file?.path ?? null, placeholder: 'docs/design.md', required: true, 'aria-label': 'Path', class: 'mono', readonly: file ? true : null });
    const content = el('textarea', { rows: '16', class: 'mono', 'aria-label': 'Content', placeholder: 'Plain text or Markdown' });
    content.value = file?.content ?? '';
    const note = el('input', { placeholder: 'What changed (optional)', maxlength: '300', 'aria-label': 'Change note' });
    return el(
      'form',
      {
        class: 'note-form plan-card',
        onsubmit: (event) => {
          event.preventDefault();
          void act(async () => {
            await api(`/projects/${encodeURIComponent(t.project)}/file`, { method: 'POST', body: { path: path.value, content: content.value, baseVersion: file?.version ?? 0, note: note.value } });
            t.openFile = path.value;
          });
        },
      },
      path,
      content,
      note,
      el('div', { class: 'row-end' }, el('button', { class: 'ghost small', type: 'button', text: 'Cancel', onclick: onCancel }), el('button', { class: 'primary small', type: 'submit', text: file ? `Save as version ${file.version + 1}` : 'Create file' })),
    );
  }

  async function showFile(container, path, version) {
    const base = `/projects/${encodeURIComponent(t.project)}/file?path=${encodeURIComponent(path)}`;
    const [file, history] = await Promise.all([api(`${base}${version ? `&version=${version}` : ''}`), api(`${base}&history=1`)]);
    const latest = history[0]?.version === file.version;
    container.replaceChildren(
      el(
        'div',
        { class: 'plan-card file-card' },
        el(
          'div',
          { class: 'plan-card-head' },
          el('h3', { class: 'mono', text: file.path }),
          el('span', { class: 'muted small', text: `version ${file.version} · ${file.updatedBy} · ${ago(file.updatedAt)}${file.note ? ` · ${file.note}` : ''}` }),
          el('span', { class: 'spacer' }),
          latest ? el('button', { class: 'ghost small', type: 'button', text: 'Edit', onclick: () => container.replaceChildren(fileEditor(file, () => void showFile(container, path))) }) : null,
          el('a', { class: 'ghost small button-link', href: '#', text: 'Close', onclick: (e) => { e.preventDefault(); t.openFile = null; renderTab(); } }),
        ),
        /\.md$/i.test(file.path) ? el('div', { class: 'md ticket-text' }, richText(file.content)) : el('pre', { class: 'file-content', text: file.content }),
        el(
          'details',
          { class: 'file-history' },
          el('summary', { class: 'small', text: `History (${history.length})` }),
          el(
            'ul',
            {},
            history.map((v) =>
              el(
                'li',
                {},
                el('a', { href: '#', text: `v${v.version}`, onclick: (e) => { e.preventDefault(); void showFile(container, path, v.version); } }),
                el('span', { class: 'muted small', text: ` ${v.author} · ${ago(v.at)}${v.note ? ` · ${v.note}` : ''}` }),
              ),
            ),
          ),
        ),
      ),
    );
  }

  function renderFiles() {
    const files = t.files ?? [];
    const viewer = el('div', { class: 'file-viewer' });
    const add = el('div', { class: 'notes-new' });
    const closed = () =>
      add.replaceChildren(
        el('button', { class: 'primary small', type: 'button', onclick: () => add.replaceChildren(fileEditor(null, closed)) }, icon('plus'), 'New file'),
        el('span', { class: 'muted small', text: 'Versioned text the project keeps: design docs, runbooks, reports. Agents read and write them too.' }),
      );
    closed();
    if (t.openFile) void showFile(viewer, t.openFile).catch(() => (t.openFile = null));
    const rows = files.map((f) =>
      el(
        'div',
        { class: 'file-row' },
        icon('file'),
        el('a', { class: 'mono', href: '#', text: f.path, onclick: (e) => { e.preventDefault(); t.openFile = f.path; void showFile(viewer, f.path); } }),
        el('span', { class: 'muted small', text: `v${f.version} · ${f.updatedBy} · ${ago(f.updatedAt)}` }),
        el('span', { class: 'spacer' }),
        el('button', {
          class: 'ghost small danger',
          type: 'button',
          text: 'Delete',
          onclick: () => confirm(`Delete ${f.path} and all its versions?`) && void act(() => api(`/projects/${encodeURIComponent(t.project)}/file?path=${encodeURIComponent(f.path)}`, { method: 'DELETE' })),
        }),
      ),
    );
    return [add, viewer, rows.length ? el('div', { class: 'file-list plan-card' }, rows) : el('p', { class: 'muted plan-intro', text: 'No files yet.' })];
  }

  function onFiles() {
    if (t.tab !== 'files' || !root || root.hidden) return;
    clearTimeout(t.timer);
    t.timer = setTimeout(() => void load(), 250);
  }

  /* Integrations: webhooks and secrets */

  function renderIntegrations() {
    const { hooks = [], secrets = { enabled: false, secrets: [] }, leases = [] } = t.integrations ?? {};
    const p = encodeURIComponent(t.project);
    const projectRooms = rooms().filter((r) => r.project === t.project);
    const agents = people().filter((m) => m.kind === 'agent');
    const reveal = el('div', { class: 'hook-reveal' });

    const hookName = el('input', { placeholder: 'GitHub CI', maxlength: '60', required: true, 'aria-label': 'Hook name' });
    const hookRoom = el('select', { 'aria-label': 'Room' }, projectRooms.map((r) => el('option', { value: r.ref, text: `#${r.name}`, selected: r.name === 'general' })));
    const hookAgent = el('select', { 'aria-label': 'Agent to wake' }, el('option', { value: '', text: 'Wake nobody' }), agents.map((a) => el('option', { value: a.name, text: `Wake ${a.name}` })));
    const hookMatch = el('input', { placeholder: 'Optional, like failure', maxlength: '100', 'aria-label': 'Wake only on matching text' });
    const hookConfirm = el('input', { type: 'checkbox', checked: true });
    const hookForm = el(
      'form',
      {
        class: 'schedule-form plan-card',
        onsubmit: async (event) => {
          event.preventDefault();
          try {
            const created = await api('/hooks', { method: 'POST', body: { room: hookRoom.value, name: hookName.value, wakeAgent: hookAgent.value || null, wakeMatch: hookMatch.value, confirmTasks: hookConfirm.checked } });
            await load();
            const url = `${location.origin}${created.path}`;
            const box = root.querySelector('.hook-reveal');
            box?.replaceChildren(
              el('p', { class: 'small', text: `POST to this URL from ${created.hook.name}. It is shown once; anyone with it can post into #${hookRoom.selectedOptions[0]?.textContent?.slice(1) ?? ''}.` }),
              el('div', { class: 'code-block' }, el('pre', {}, el('code', { text: url }))),
              el('button', { class: 'small', type: 'button', text: 'Copy URL', onclick: () => void navigator.clipboard.writeText(url) }),
            );
          } catch (err) {
            notify(err.message);
          }
        },
      },
      el('h3', { text: 'New webhook' }),
      el('div', { class: 'schedule-grid' },
        el('label', { class: 'field' }, el('span', { class: 'small muted', text: 'Name' }), hookName),
        el('label', { class: 'field' }, el('span', { class: 'small muted', text: 'Posts into' }), hookRoom),
        el('label', { class: 'field' }, el('span', { class: 'small muted', text: 'Wake an agent' }), hookAgent),
        el('label', { class: 'field' }, el('span', { class: 'small muted', text: 'Only when it mentions' }), hookMatch),
      ),
      el(
        'label',
        { class: 'check small', title: 'Payloads come from outside Orco. Without this, a payload can set the agent to work on its own.' },
        hookConfirm,
        'Ask me before the agent starts',
      ),
      el('div', { class: 'row-end' }, el('button', { class: 'primary small', type: 'submit', text: 'Create webhook' })),
    );
    const hookRows = hooks.map((h) =>
      el(
        'div',
        { class: 'file-row' },
        el('strong', { text: h.name }),
        el('span', { class: 'muted small', text: `#${h.room.split('/').pop()}${h.wakeAgent ? ` · wakes ${h.wakeAgent}${h.wakeMatch ? ` on “${h.wakeMatch}”` : ''}${h.confirmTasks ? ' after you approve' : ''}` : ''} · ${h.deliveries} deliveries${h.lastAt ? `, last ${ago(h.lastAt)}` : ''}` }),
        el('span', { class: 'spacer' }),
        el('button', { class: 'ghost small danger', type: 'button', text: 'Remove', onclick: () => confirm(`Remove the ${h.name} webhook? Its URL stops working.`) && void act(() => api(`/hooks/${h.id}`, { method: 'DELETE' })) }),
      ),
    );

    const secretName = el('input', { placeholder: 'STRIPE_TEST_KEY', required: true, pattern: '[A-Z][A-Z0-9_]*', 'aria-label': 'Secret name', class: 'mono' });
    const secretValue = el('input', { type: 'password', required: true, autocomplete: 'off', 'aria-label': 'Value' });
    const secretDescription = el('input', { placeholder: 'What it is for (optional)', maxlength: '300', 'aria-label': 'Description' });
    const secretForm = el(
      'form',
      {
        class: 'schedule-form plan-card',
        onsubmit: (event) => {
          event.preventDefault();
          void act(async () => {
            await api(`/projects/${p}/secrets`, { method: 'POST', body: { name: secretName.value, value: secretValue.value, description: secretDescription.value } });
            secretValue.value = '';
          });
        },
      },
      el('h3', { text: 'Store a secret' }),
      el('div', { class: 'schedule-grid' },
        el('label', { class: 'field' }, el('span', { class: 'small muted', text: 'Name' }), secretName),
        el('label', { class: 'field' }, el('span', { class: 'small muted', text: 'Value (cannot be read back)' }), secretValue),
        el('label', { class: 'field' }, el('span', { class: 'small muted', text: 'Description' }), secretDescription),
      ),
      el('div', { class: 'row-end' }, el('button', { class: 'primary small', type: 'submit', text: 'Store' })),
    );
    const secretRows = secrets.secrets.map((x) =>
      el(
        'div',
        { class: 'file-row' },
        el('strong', { class: 'mono', text: x.name }),
        el('span', { class: 'muted small', text: `${x.description ? `${x.description} · ` : ''}stored by ${x.owner} · ${ago(x.updatedAt)}` }),
        el('span', { class: 'spacer' }),
        x.owner === me().name
          ? el('button', { class: 'ghost small danger', type: 'button', text: 'Delete', onclick: () => confirm(`Delete ${x.name}? Agents using it lose access.`) && void act(() => api(`/projects/${p}/secrets/${encodeURIComponent(x.name)}`, { method: 'DELETE' })) })
          : null,
      ),
    );
    const leaseRows = leases.map((l) =>
      el(
        'div',
        { class: 'file-row' },
        el('span', { class: `chip lease-${l.state}`, text: l.state }),
        el('span', { class: 'small', text: `${l.agent} → ${l.secret} for task #${l.taskId}: ${l.reason}` }),
        el('span', { class: 'muted small', text: `${l.uses} use${l.uses === 1 ? '' : 's'}` }),
        el('span', { class: 'spacer' }),
        l.state === 'granted' || l.state === 'pending'
          ? el('button', { class: 'ghost small danger', type: 'button', text: 'Revoke', onclick: () => void act(() => api(`/leases/${l.id}/revoke`, { method: 'POST', body: {} })) })
          : null,
      ),
    );
    return [
      el('section', { class: 'settings-section' },
        el('h3', { text: 'Webhooks' }),
        el('p', { class: 'muted small', text: 'A secret URL that CI, GitHub or monitoring can POST to. Each delivery is posted in the room as untrusted external text, and can start a task for an agent. Orco only receives; it never calls out.' }),
        hookRows.length ? el('div', { class: 'file-list plan-card' }, hookRows) : null,
        reveal,
        projectRooms.length ? hookForm : null,
      ),
      el('section', { class: 'settings-section' },
        el('h3', { text: 'Secrets' }),
        secrets.enabled
          ? [
              el('p', { class: 'muted small', text: 'API keys and passwords agents can borrow for a task. Nobody can read a value back here. An agent asks for one; whoever stored it approves in their Inbox; the agent can then read it until the task closes (8 hours at most). Every use is logged by name.' }),
              secretRows.length ? el('div', { class: 'file-list plan-card' }, secretRows) : null,
              secretForm,
              leaseRows.length ? [el('h4', { class: 'small', text: 'Leases' }), el('div', { class: 'file-list plan-card' }, leaseRows)] : null,
            ]
          : el('p', { class: 'muted small', text: 'Secrets are off on this server. An admin turns them on by setting ORCO_SECRETS_KEY (32 random bytes, like the output of openssl rand -hex 32) and restarting.' }),
      ),
    ];
  }

  /* Schedules */

  function scheduleForm() {
    const agents = people().filter((p) => p.kind === 'agent');
    const projectRooms = rooms().filter((r) => r.project === t.project);
    const agent = el('select', { 'aria-label': 'Agent', required: true }, agents.map((a) => el('option', { value: a.name, text: a.owner ? `${a.name} (${a.owner})` : a.name })));
    const room = el('select', { 'aria-label': 'Room' }, projectRooms.map((r) => el('option', { value: r.ref, text: `#${r.name}`, selected: r.name === 'general' })));
    const request = el('textarea', { rows: '3', required: true, maxlength: '4000', placeholder: 'What the agent should do each time, like “Triage tickets filed since the last run”', 'aria-label': 'Request' });
    const cron = el('input', { value: CRON_PRESETS[0][0], required: true, 'aria-label': 'Schedule (cron)', class: 'mono', spellcheck: 'false' });
    const preset = el(
      'select',
      { 'aria-label': 'Common schedules', onchange: (event) => event.target.value && (cron.value = event.target.value) },
      el('option', { value: '', text: 'Common schedules…' }),
      CRON_PRESETS.map(([value, label]) => el('option', { value, text: label })),
    );
    const tz = el('input', { value: Intl.DateTimeFormat().resolvedOptions().timeZone, 'aria-label': 'Time zone', spellcheck: 'false' });
    const minutes = el('input', { type: 'number', min: '1', max: '10080', placeholder: 'No limit', 'aria-label': 'Time budget in minutes' });
    if (agents.length === 0) return el('p', { class: 'muted plan-intro', text: 'No agents can see this project yet. Add their owners as members first.' });
    return el(
      'form',
      {
        class: 'schedule-form plan-card',
        onsubmit: (event) => {
          event.preventDefault();
          void act(() =>
            api('/schedules', {
              method: 'POST',
              body: {
                agent: agent.value,
                room: room.value,
                request: request.value,
                cron: cron.value,
                tz: tz.value,
                budgetMinutes: minutes.value ? Number(minutes.value) : undefined,
              },
            }),
          );
        },
      },
      el('h3', { text: 'New schedule' }),
      el('div', { class: 'schedule-grid' },
        el('label', { class: 'field' }, el('span', { class: 'small muted', text: 'Agent' }), agent),
        el('label', { class: 'field' }, el('span', { class: 'small muted', text: 'Room' }), room),
        el('label', { class: 'field' }, el('span', { class: 'small muted', text: 'When (minute hour day month weekday)' }), cron),
        el('label', { class: 'field' }, el('span', { class: 'small muted', text: 'Preset' }), preset),
        el('label', { class: 'field' }, el('span', { class: 'small muted', text: 'Time zone' }), tz),
        el('label', { class: 'field' }, el('span', { class: 'small muted', text: 'Time budget (minutes)' }), minutes),
      ),
      el('label', { class: 'field' }, el('span', { class: 'small muted', text: 'Request' }), request),
      el('div', { class: 'row-end' }, el('button', { class: 'primary small', type: 'submit', text: 'Create schedule' })),
    );
  }

  function renderSchedules() {
    const list = t.schedules ?? [];
    const cards = list.map((s) =>
      el(
        'article',
        { class: `plan-card schedule-card${s.enabled ? '' : ' paused'}` },
        el(
          'div',
          { class: 'plan-card-head' },
          icon('clock'),
          el('h3', { text: `${s.agent} in #${s.room.split('/').pop()}` }),
          el('span', {
            class: `chip${s.approval === 'pending' ? ' waiting' : ''}`,
            text: s.approval === 'pending' ? 'Waiting for approval' : s.approval === 'denied' ? 'Not approved' : s.approval === 'expired' && !s.runAs ? 'Approval expired' : s.enabled ? 'Active' : 'Paused',
          }),
          el('span', { class: 'spacer' }),
          el('button', {
            class: 'ghost small',
            type: 'button',
            text: s.enabled ? 'Pause' : 'Resume',
            onclick: () => void act(() => api(`/schedules/${s.id}`, { method: 'POST', body: { enabled: !s.enabled } })),
          }),
          el('button', {
            class: 'ghost small danger',
            type: 'button',
            text: 'Delete',
            onclick: () => confirm('Delete this schedule?') && void act(() => api(`/schedules/${s.id}`, { method: 'DELETE' })),
          }),
        ),
        el('p', { class: 'schedule-request', text: s.request }),
        el(
          'p',
          { class: 'muted small' },
          el('code', { text: s.cron }),
          ` ${s.tz} · set up by ${s.creator}${s.runAs && s.runAs !== s.creator ? `, runs as ${s.runAs}` : ''}`,
          s.enabled ? ` · next ${new Date(s.nextRun).toLocaleString([], { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' })}` : '',
          s.budgetMinutes ? ` · ${s.budgetMinutes} min budget` : '',
          s.lastRun ? ` · last ran ${ago(s.lastRun)}${s.lastTaskId ? ` (task #${s.lastTaskId})` : ''}` : '',
        ),
        s.lastError ? el('p', { class: 'small warning-text', text: s.lastError }) : null,
      ),
    );
    return [
      el('p', { class: 'muted plan-intro', text: 'Recurring tasks. Each run is an ordinary task created as the person who set it up (or who approved an agent’s proposal), so the agent’s consent rules apply. A run is skipped while the previous one is still open. Agents can propose schedules; they wait in their owner’s Inbox.' }),
      cards.length ? cards : el('p', { class: 'muted plan-intro', text: 'No schedules yet.' }),
      scheduleForm(),
    ];
  }

  function onSchedules() {
    if (t.tab !== 'schedules' || !root || root.hidden) return;
    clearTimeout(t.timer);
    t.timer = setTimeout(() => void load(), 250);
  }

  /* Settings: workflow and labels */

  function renderSettings() {
    const statuses = t.plan.statuses;
    const base = `/projects/${encodeURIComponent(t.project)}`;
    const categoryOptions = Object.entries(CATEGORY_LABEL);
    const rows = statuses.map((s, i) => {
      const name = el('input', { value: s.name, maxlength: '40', 'aria-label': `Name of ${s.name}` });
      name.addEventListener('change', () => void act(() => api(`${base}/statuses/${s.id}`, { method: 'POST', body: { name: name.value } })));
      const row = el(
        'div',
        { class: 'status-row' },
        statusIcon(s.category),
        name,
        select(s.category, categoryOptions, (category) => void act(() => api(`${base}/statuses/${s.id}`, { method: 'POST', body: { category } })), {
          'aria-label': `Category of ${s.name}`,
        }),
        el('button', { class: 'ghost small', type: 'button', disabled: i === 0 ? true : null, 'aria-label': `Move ${s.name} up`, text: '↑', onclick: () => void act(() => api(`${base}/statuses/${s.id}`, { method: 'POST', body: { position: i - 1 } })) }),
        el('button', { class: 'ghost small', type: 'button', disabled: i === statuses.length - 1 ? true : null, 'aria-label': `Move ${s.name} down`, text: '↓', onclick: () => void act(() => api(`${base}/statuses/${s.id}`, { method: 'POST', body: { position: i + 1 } })) }),
        el('button', {
          class: 'ghost small danger',
          type: 'button',
          text: 'Remove',
          onclick: () => {
            const target = select('', statuses.filter((o) => o.id !== s.id).map((o) => [String(o.id), o.name]), () => {}, { 'aria-label': 'Move its tickets to' });
            row.replaceChildren(
              el('span', { class: 'small', text: `Remove ${s.name} and move its tickets to` }),
              target,
              el('button', { class: 'small danger', type: 'button', text: 'Remove', onclick: () => void act(() => api(`${base}/statuses/${s.id}?move_to=${target.value}`, { method: 'DELETE' })) }),
              el('button', { class: 'ghost small', type: 'button', text: 'Cancel', onclick: renderTab }),
            );
          },
        }),
      );
      return row;
    });
    const newName = el('input', { placeholder: 'New status, like QA', maxlength: '40', required: true, 'aria-label': 'New status name' });
    let newCategory = 'started';
    const addStatus = el(
      'form',
      {
        class: 'inline-form',
        onsubmit: (event) => {
          event.preventDefault();
          void act(() => api(`${base}/statuses`, { method: 'POST', body: { name: newName.value, category: newCategory } }));
        },
      },
      newName,
      select(newCategory, categoryOptions, (v) => (newCategory = v), { 'aria-label': 'Category' }),
      el('button', { class: 'primary small', type: 'submit', text: 'Add status' }),
    );

    const labelName = el('input', { placeholder: 'New label, like bug', maxlength: '32', required: true, 'aria-label': 'New label name' });
    const colors = ['#e5484d', '#f76b15', '#ffc53d', '#46a758', '#12a594', '#0090ff', '#6e56cf', '#d6409f', '#8d8d8d'];
    let color = colors[t.plan.labels.length % colors.length];
    const swatches = el(
      'div',
      { class: 'swatches', role: 'radiogroup', 'aria-label': 'Label color' },
      colors.map((c) => {
        const swatch = el('button', {
          type: 'button',
          class: 'swatch',
          role: 'radio',
          'aria-checked': c === color ? 'true' : 'false',
          'aria-label': c,
          onclick: () => {
            color = c;
            for (const node of swatches.children) node.setAttribute('aria-checked', String(node === swatch));
          },
        });
        swatch.style.background = c;
        return swatch;
      }),
    );
    const addLabel = el(
      'form',
      {
        class: 'inline-form',
        onsubmit: (event) => {
          event.preventDefault();
          void act(() => api(`${base}/labels`, { method: 'POST', body: { name: labelName.value, color } }));
        },
      },
      labelName,
      swatches,
      el('button', { class: 'primary small', type: 'submit', text: 'Add label' }),
    );

    // Folders (#91): rename, give an emoji, reorder, remove (its tickets stay, in no folder).
    const folders = t.plan.folders ?? [];
    const folderRows = folders.map((f, i) => {
      const emoji = el('input', { class: 'folder-emoji-input', value: f.emoji ?? null, maxlength: '16', placeholder: '📁', 'aria-label': `Emoji for ${f.name}` });
      emoji.addEventListener('change', () => void act(() => api(`${base}/folders/${f.id}`, { method: 'POST', body: { emoji: emoji.value || null } })));
      const name = el('input', { value: f.name, maxlength: '40', 'aria-label': `Name of folder ${f.name}` });
      name.addEventListener('change', () => void act(() => api(`${base}/folders/${f.id}`, { method: 'POST', body: { name: name.value } })));
      return el(
        'div',
        { class: 'status-row folder-row' },
        emoji,
        name,
        el('span', { class: 'muted small', text: `${f.open} open · ${f.total} in all` }),
        el('button', { class: 'ghost small', type: 'button', disabled: i === 0 ? true : null, 'aria-label': `Move ${f.name} up`, text: '↑', onclick: () => void act(() => api(`${base}/folders/${f.id}`, { method: 'POST', body: { position: i - 1 } })) }),
        el('button', { class: 'ghost small', type: 'button', disabled: i === folders.length - 1 ? true : null, 'aria-label': `Move ${f.name} down`, text: '↓', onclick: () => void act(() => api(`${base}/folders/${f.id}`, { method: 'POST', body: { position: i + 1 } })) }),
        el('button', {
          class: 'ghost small danger',
          type: 'button',
          text: 'Remove',
          onclick: () => {
            if (confirm(`Remove the folder ${f.name}? Its ${f.total} ticket${f.total === 1 ? '' : 's'} stay, in no folder.`)) void act(() => api(`${base}/folders/${f.id}`, { method: 'DELETE' }));
          },
        }),
      );
    });
    const folderName = el('input', { placeholder: 'New folder, like Kiosk', maxlength: '40', required: true, 'aria-label': 'New folder name' });
    const folderEmoji = el('input', { class: 'folder-emoji-input', maxlength: '16', placeholder: '📁', 'aria-label': 'New folder emoji' });
    const addFolder = el(
      'form',
      {
        class: 'inline-form',
        onsubmit: (event) => {
          event.preventDefault();
          void act(() => api(`${base}/folders`, { method: 'POST', body: { name: folderName.value, emoji: folderEmoji.value || null } }));
        },
      },
      folderEmoji,
      folderName,
      el('button', { class: 'primary small', type: 'submit', text: 'Add folder' }),
    );

    if (me().kind !== 'user') return el('p', { class: 'muted plan-intro', text: 'Only people can change the workflow.' });
    return [
      el('section', { class: 'settings-section' },
        el('h3', { text: 'Folders' }),
        el('p', { class: 'muted small', text: 'Group tickets by area. The board and list show a group per folder; agents can add folders and file tickets into them.' }),
        folderRows.length ? el('div', { class: 'status-list' }, folderRows) : el('p', { class: 'muted small', text: 'No folders yet.' }),
        addFolder,
      ),
      el('section', { class: 'settings-section' },
        el('h3', { text: 'Workflow' }),
        el('p', { class: 'muted small', text: `Statuses in board order. The category tells boards and agents what each one means. Ticket key: ${t.plan.key}.` }),
        el('div', { class: 'status-list' }, rows),
        addStatus,
      ),
      el('section', { class: 'settings-section' },
        el('h3', { text: 'Labels' }),
        el('p', { class: 'muted small', text: 'Agents can add labels and put them on tickets; only people delete them.' }),
        el(
          'div',
          { class: 'label-list' },
          t.plan.labels.length
            ? t.plan.labels.map((label) =>
                el(
                  'span',
                  { class: 'label-item' },
                  labelChip(label),
                  el('button', {
                    class: 'ghost icon',
                    type: 'button',
                    'aria-label': `Delete label ${label.name}`,
                    onclick: () => {
                      if (confirm(`Delete label ${label.name}? It comes off every ticket.`)) void act(() => api(`${base}/labels/${label.id}`, { method: 'DELETE' }));
                    },
                  }, icon('x')),
                ),
              )
            : el('span', { class: 'muted small', text: 'No labels yet.' }),
        ),
        addLabel,
      ),
    ];
  }

  async function act(fn) {
    try {
      await fn();
      await load();
    } catch (err) {
      notify(err.message);
    }
  }

  function notify(text) {
    if (!text) return;
    const toast = el('div', { class: 'toast', role: 'status', text });
    document.body.append(toast);
    setTimeout(() => toast.remove(), 5000);
  }

  // Apply live updates that waited while someone was typing.
  root.addEventListener('focusout', () =>
    setTimeout(() => {
      if (t.pendingTab && !typing($('ticket-body'))) renderTab();
    }),
  );
  $('panel-body').addEventListener('focusout', () =>
    setTimeout(() => {
      if (t.pendingDetail && !typing($('panel-body'))) void openTicket(t.open, { refresh: true });
    }),
  );

  // A ticket as a row in the Inbox: status, key, title, priority and project, opening the ticket.
  function inboxRow(ticket) {
    return el(
      'button',
      { class: 'inbox-row inbox-ticket', type: 'button', onclick: () => void openTicket(ticket.ref) },
      el(
        'span',
        { class: 'inbox-ticket-line' },
        statusIcon(ticket.status.category),
        el('span', { class: 'ticket-ref', text: ticket.ref }),
        el('span', { class: 'list-title', text: ticket.title }),
        ticket.priority !== 'none' ? priorityIcon(ticket.priority) : null,
      ),
      stateLine(ticket),
      ticket.nextStep ? el('span', { class: 'ticket-next', text: `Next: ${ticket.nextStep.text}` }) : null,
      el(
        'span',
        { class: 'inbox-meta muted' },
        `${ticket.status.name} · ${ticket.project}`,
        ticket.dueDate ? ` · due ${shortDate(ticket.dueDate)}` : '',
        ticket.task ? ` · ${TASK_TEXT[ticket.task.state].toLowerCase()}` : '',
      ),
    );
  }

  /** The ticket open in the panel, for commands and the palette (#93). */
  const openRef = () => (panel() === 'ticket' && t.open ? { ref: t.open, project: t.openProject } : null);

  return { show, onEvent, onTask, onNotes, onSchedules, onFiles, inboxRow, openTicket, openNewTicket, navFolders, openRef, planFor, get project() { return t.project; } };
}
