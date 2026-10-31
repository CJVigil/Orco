// Tickets: board, list, ticket details, milestones, cycles and workflow settings for one project.
// Builds DOM through the `el` helper from app.js; ticket text is untrusted and only ever set as text.

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
const EMPTY_FILTERS = { q: '', assignee: '', label: '', priority: '', milestone: '', cycle: '', blocked: '' };

/** Why a ticket is blocked, for tooltips: open blocking tickets and any outside reason. */
function blockedWhy(ticket) {
  return [ticket.blockedBy.length ? `Waiting on ${ticket.blockedBy.join(', ')}` : null, ticket.blockedReason].filter(Boolean).join('; ');
}

export function createTickets(ctx) {
  const { api, el, icon, avatar, richText, openPanel, closePanel, panel, jumpTo, me, rooms, $ } = ctx;
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
    t.tickets = tickets;
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
      TABS.map(([key, label]) =>
        el('a', { href: `#~${t.project}/${key}`, class: 'ticket-tab', 'aria-current': key === t.tab ? 'page' : null, text: label }),
      ),
      el('span', { class: 'spacer' }),
      el('button', { class: 'primary small', type: 'button', onclick: () => openNewTicket() }, icon('plus'), 'New ticket'),
    );
    const body = el('div', { id: 'ticket-body', class: `ticket-body tab-${t.tab}` });
    root.replaceChildren(...[tabs, t.tab === 'board' || t.tab === 'list' ? filterBar() : null, body].filter(Boolean));
    if (!t.plan) body.append(el('p', { class: 'muted empty', text: 'Loading…' }));
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
      select(f.blocked, [['', 'Blocked or not'], ['1', 'Blocked'], ['0', 'Not blocked']], set('blocked'), { 'aria-label': 'Blocked' }),
      Object.values(f).some(Boolean)
        ? el('button', { class: 'ghost small', type: 'button', text: 'Clear', onclick: () => ((t.filters = { ...EMPTY_FILTERS }), renderShell(), void refreshTickets()) })
        : null,
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

  /* Board */

  let dragging = null;

  function card(ticket) {
    const node = el(
      'article',
      {
        class: 'ticket-card',
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
      el('div', { class: 'ticket-card-top' }, el('span', { class: 'ticket-ref', text: ticket.ref }), ticket.assignee ? avatar(ticket.assignee.name, ticket.assignee.kind) : null),
      el('div', { class: 'ticket-title', text: ticket.title }),
      el(
        'div',
        { class: 'ticket-meta' },
        ticket.priority !== 'none' ? priorityIcon(ticket.priority) : null,
        ticket.blocked ? el('span', { class: 'meta-pill blocked', title: blockedWhy(ticket), text: 'Blocked' }) : null,
        taskBadge(ticket.task),
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
    const columns = t.plan.statuses.filter((s) => s.category !== 'canceled');
    const byStatus = new Map(columns.map((s) => [s.id, []]));
    for (const ticket of t.tickets) byStatus.get(ticket.status.id)?.push(ticket);
    const canceled = t.tickets.filter((x) => x.status.category === 'canceled').length;
    const board = el(
      'div',
      { class: 'board' },
      columns.map((status) => {
        const tickets = byStatus.get(status.id);
        const list = el('div', { class: 'column-cards', 'data-status': status.name }, tickets.map(card));
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
          void api(`/tickets/${ticket.ref}`, { method: 'POST', body: { status: status.name, sort } })
            .then((result) => notify(result.warning))
            .catch((err) => notify(err.message))
            .finally(() => void refreshTickets());
        });
        return el(
          'section',
          { class: `board-column cat-${status.category}` },
          el(
            'header',
            { class: 'column-head' },
            statusIcon(status.category),
            el('span', { class: 'column-name', text: status.name }),
            el('span', { class: 'muted small', text: String(tickets.length) }),
            el('span', { class: 'spacer' }),
            el('button', { class: 'ghost icon', type: 'button', title: `New ticket in ${status.name}`, 'aria-label': `New ticket in ${status.name}`, onclick: () => openNewTicket({ status: status.name }) }, icon('plus')),
          ),
          list,
        );
      }),
    );
    return [board, canceled ? el('p', { class: 'muted small board-note', text: `${canceled} canceled ${canceled === 1 ? 'ticket is' : 'tickets are'} in the List view.` }) : null];
  }

  /* List */

  function renderList() {
    if (t.tickets.length === 0) return emptyState();
    return t.plan.statuses.map((status) => {
      const tickets = t.tickets.filter((x) => x.status.id === status.id);
      if (tickets.length === 0) return null;
      return el(
        'details',
        { class: 'list-group', open: status.category === 'completed' || status.category === 'canceled' ? null : true },
        el('summary', {}, statusIcon(status.category), el('span', { text: status.name }), el('span', { class: 'muted small', text: String(tickets.length) })),
        tickets.map((ticket) =>
          el(
            'button',
            { class: 'list-row', type: 'button', onclick: () => void openTicket(ticket.ref) },
            priorityIcon(ticket.priority),
            el('span', { class: 'ticket-ref', text: ticket.ref }),
            el('span', { class: 'list-title', text: ticket.title }),
            el('span', { class: 'list-meta' }, ticket.blocked ? el('span', { class: 'meta-pill blocked', title: blockedWhy(ticket), text: 'Blocked' }) : null, taskBadge(ticket.task), ticket.labels.map(labelChip), ticket.estimate !== null ? el('span', { class: 'meta-pill', text: `${ticket.estimate} pt` }) : null, ticket.dueDate ? el('span', { class: 'meta-pill', text: shortDate(ticket.dueDate) }) : null),
            ticket.assignee ? avatar(ticket.assignee.name, ticket.assignee.kind) : el('span', { class: 'avatar-blank', title: 'Unassigned' }),
          ),
        ),
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
      field('Estimate', estimate),
      field('Due', due),
      field('Milestone', select(ticket.milestone?.name ?? '', [['', 'None'], ...plan.milestones.map((m) => [m.name, m.name])], change('milestone', (v) => v || null), { 'aria-label': 'Milestone' })),
      field('Cycle', select(ticket.cycle?.number ?? '', [['', 'None'], ...cycles.map((c) => [String(c.number), c.name])], change('cycle', (v) => (v ? Number(v) : null)), { 'aria-label': 'Cycle' })),
      field('Labels', labelPicker),
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
        props,
        agentRow,
        handoffBlock(ticket),
        descriptionBlock(ticket),
        criteriaBlock(ticket),
        linksBlock(ticket),
        childrenBlock(ticket),
        activityBlock(ticket, draft),
      ),
    );
    autosize(title);
  }

  function autosize(textarea) {
    textarea.style.height = 'auto';
    textarea.style.height = `${textarea.scrollHeight}px`;
    textarea.addEventListener('input', () => {
      textarea.style.height = 'auto';
      textarea.style.height = `${textarea.scrollHeight}px`;
    });
  }

  function handoffBlock(ticket) {
    const wrap = el('section', { class: 'detail-section' });
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
        h ? el('div', { class: 'md ticket-text handoff' }, richText(h.text)) : el('p', { class: 'muted small', text: 'Where the work stands, for whoever picks it up next. Agents keep this current.' }),
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
    view();
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
      { class: 'detail-section' },
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
      { class: 'detail-section' },
      el(
        'div',
        { class: 'section-head' },
        el('h3', { text: 'Dependencies' }),
        open ? el('span', { class: 'meta-pill blocked', title: blockedWhy(ticket), text: 'Blocked' }) : null,
        el('span', { class: 'spacer' }),
      ),
      ticket.blockers.length ? el('p', { class: 'muted small link-label', text: 'Blocked by' }) : null,
      ticket.blockers.map((b) => row(b, () => void save(ticket, { blockedByRemove: [b.ref] }))),
      ticket.blocking.length ? el('p', { class: 'muted small link-label', text: 'Blocking' }) : null,
      ticket.blocking.map((b) => row(b, null)),
      reason,
      add,
    );
  }

  function descriptionBlock(ticket) {
    const wrap = el('section', { class: 'detail-section' });
    const view = () => {
      t.editing = false;
      wrap.replaceChildren(
        el('div', { class: 'section-head' }, el('h3', { text: 'Description' }), el('button', { class: 'ghost small', type: 'button', text: 'Edit', onclick: edit })),
        ticket.description ? el('div', { class: 'md ticket-text' }, richText(ticket.description)) : el('p', { class: 'muted small', text: 'No description.' }),
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
    view();
    return wrap;
  }

  function childrenBlock(ticket) {
    return el(
      'section',
      { class: 'detail-section' },
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
        return 'edited the description';
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
    const items = ticket.activity.map((a) => {
      const who = a.actor ?? 'Orco';
      if (a.kind === 'comment') {
        return el(
          'li',
          { class: 'activity-comment' },
          avatar(who, a.actorKind),
          el(
            'div',
            { class: 'comment-main' },
            el('div', { class: 'comment-head' }, el('strong', { text: who }), el('span', { class: 'muted small', text: ago(a.createdAt) })),
            el('div', { class: 'md ticket-text' }, richText(a.body)),
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
    const box = el('textarea', { rows: '2', placeholder: 'Leave a comment', 'aria-label': 'Comment' });
    box.value = draft;
    const send = async () => {
      if (!box.value.trim()) return;
      try {
        const updated = await api(`/tickets/${ticket.ref}/comments`, { method: 'POST', body: { text: box.value } });
        box.value = '';
        renderDetail(updated);
      } catch (err) {
        notify(err.message);
      }
    };
    box.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) void send();
    });
    return el(
      'section',
      { class: 'detail-section' },
      el('div', { class: 'section-head' }, el('h3', { text: 'Activity' })),
      el('ol', { class: 'activity' }, items),
      el('div', { class: 'comment-box' }, box, el('div', { class: 'row-end' }, el('button', { class: 'primary small', type: 'button', text: 'Comment', onclick: () => void send() }))),
      el('p', { class: 'muted small detail-foot', text: `Opened by ${ticket.creator} ${ago(ticket.createdAt)} · updated ${ago(ticket.updatedAt)}` }),
    );
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
      el('div', { class: 'new-ticket-grid' }, fields.status, fields.priority, fields.assignee, estimate, fields.milestone, fields.cycle),
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

    if (me().kind !== 'user') return el('p', { class: 'muted plan-intro', text: 'Only people can change the workflow.' });
    return [
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
      el(
        'span',
        { class: 'inbox-meta muted' },
        `${ticket.status.name} · ${ticket.project}`,
        ticket.dueDate ? ` · due ${shortDate(ticket.dueDate)}` : '',
        ticket.task ? ` · ${TASK_TEXT[ticket.task.state].toLowerCase()}` : '',
      ),
    );
  }

  return { show, onEvent, onNotes, onSchedules, onFiles, inboxRow, openTicket, openNewTicket, get project() { return t.project; } };
}
