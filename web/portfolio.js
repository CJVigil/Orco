import { phoneLinkBlock } from './phone.js';
// The view across projects: health per project, the roadmap, decisions, weekly digests, and the
// controls for running many projects (pauses, budgets, policies, groups). DOM built with el() only.

const TABS = [
  ['overview', 'Overview'],
  ['roadmap', 'Roadmap'],
  ['decisions', 'Decisions'],
  ['digest', 'Digest'],
  ['controls', 'Controls'],
  ['tools', 'Tool use'],
  ['memory', 'Org memory'],
];

const HEALTH_TEXT = { red: 'Needs attention', amber: 'Watch', green: 'On track' };
const MILESTONE_TEXT = { done: 'Done', late: 'Late', at_risk: 'At risk', on_track: 'On track', no_date: 'No date' };

export function createPortfolio(ctx) {
  const { api, el, richText, me, $, projects, onJoin } = ctx;
  const root = $('portfolio-view');
  const p = { tab: 'overview', timer: null, decisionQuery: '', decisionProject: '', digestProject: '', policyProject: '' };

  const money = (cents) => `$${(cents / 100).toFixed(2)}`;
  const dollars = (value) => {
    const n = Number(String(value).replace(/[$,\s]/g, ''));
    return Number.isFinite(n) && n > 0 ? Math.round(n * 100) : null;
  };
  const shortDate = (date) => new Date(`${date}T00:00:00`).toLocaleDateString([], { month: 'short', day: 'numeric' });
  const isAdmin = () => me()?.orgAdmin === true;
  const adminOf = () => projects().filter((pr) => pr.role === 'admin').map((pr) => pr.name);

  function notify(text) {
    if (!text) return;
    const toast = el('div', { class: 'toast', role: 'status', text });
    document.body.append(toast);
    setTimeout(() => toast.remove(), 5000);
  }

  async function act(fn) {
    try {
      await fn();
      await load();
    } catch (err) {
      notify(err.message);
    }
  }

  async function show(tab) {
    p.tab = TABS.some(([key]) => key === tab) ? tab : 'overview';
    const tabs = el(
      'nav',
      { class: 'ticket-tabs', 'aria-label': 'Portfolio views' },
      TABS.map(([key, label]) => el('a', { href: `#!portfolio/${key}`, class: 'ticket-tab', 'aria-current': key === p.tab ? 'page' : null, text: label })),
    );
    root.replaceChildren(tabs, el('div', { id: 'portfolio-body', class: 'ticket-body portfolio-body' }, el('p', { class: 'muted empty', text: 'Loading…' })));
    await load();
  }

  function onEvent() {
    if (root.hidden) return;
    clearTimeout(p.timer);
    // Leave forms alone while someone is typing in them.
    p.timer = setTimeout(() => {
      if (!root.contains(document.activeElement) || document.activeElement === document.body) void load();
    }, 400);
  }

  async function load() {
    const body = $('portfolio-body');
    if (!body) return;
    try {
      const view = await { overview, roadmap, decisions, digest, controls, tools, memory }[p.tab]();
      body.replaceChildren(...[view].flat(3).filter(Boolean));
    } catch (err) {
      body.replaceChildren(el('p', { class: 'error', text: err.message }));
    }
  }

  /*
   * Org memory (#144): notes every agent loads. Agents propose; org admins approve or reject, and
   * decide on requests to forget. Anyone can propose; an org admin's note is live at once.
   */
  async function memory() {
    const admin = Boolean(me()?.orgAdmin);
    const [live, queue] = await Promise.all([api('/org-notes'), api('/org-notes?state=proposed')]);
    const act = (fn) => void fn().then(load, (err) => notify(err.message));
    const typeChip = (t) => el('span', { class: 'chip', text: t });
    const noteCard = (n, actions) =>
      el(
        'article',
        { class: `plan-card org-note${n.expired ? ' expired' : ''}` },
        el('div', { class: 'plan-card-head' }, typeChip(n.type), el('h3', { text: n.name }), el('span', { class: 'spacer' }), actions),
        n.description ? el('p', { class: 'small', text: n.description }) : null,
        el('div', { class: 'md org-note-body' }, richText(n.body)),
        el('p', {
          class: 'muted small',
          text: `By ${n.author} · ${n.created.slice(0, 10)}${n.source ? ` · from ${n.source}` : ''}${n.approvedBy ? ` · approved by ${n.approvedBy}` : ''}${n.expires ? ` · ${n.expired ? 'expired' : 'until'} ${n.expires}` : ''}`,
        }),
        n.forgetRequestedBy ? el('p', { class: 'small warning-note', text: `${n.forgetRequestedBy} asks to forget this.` }) : null,
      );
    const name = el('input', { maxlength: '80', required: true, placeholder: 'Deploy freeze', 'aria-label': 'Name' });
    const description = el('input', { maxlength: '200', placeholder: 'One line for the index', 'aria-label': 'Description' });
    const type = el('select', { 'aria-label': 'Type' }, ['rule', 'fact', 'howto', 'contact', 'status'].map((t) => el('option', { value: t, text: t })));
    const body = el('textarea', { rows: '4', required: true, maxlength: '8000', placeholder: 'One fact per note. Link others with [[their-name]]; mention tickets like API-12.', 'aria-label': 'Note' });
    const source = el('input', { maxlength: '100', placeholder: 'API-12 or message 123', 'aria-label': 'Source' });
    const expires = el('input', { type: 'date', 'aria-label': 'Expires' });
    return [
      el('p', { class: 'muted plan-intro', text: 'Notes every agent loads as shared memory. Agents propose them; an org admin approves before they go live. Statuses expire and are then flagged, not stated as current. orco vault export <dir> opens them in Obsidian.' }),
      queue.notes.length
        ? el(
            'section',
            { class: 'settings-section' },
            el('h3', { text: admin ? `Waiting for approval (${queue.notes.length})` : 'Your proposals' }),
            queue.notes.map((n) =>
              noteCard(
                n,
                admin
                  ? el(
                      'span',
                      { class: 'row-end' },
                      el('button', { class: 'primary small', type: 'button', text: 'Approve', onclick: () => act(() => api(`/org-notes/${n.id}/approve`, { method: 'POST', body: {} })) }),
                      el('button', { class: 'ghost small danger', type: 'button', text: 'Reject', onclick: () => act(() => api(`/org-notes/${n.id}/reject`, { method: 'POST', body: {} })) }),
                    )
                  : el('span', { class: 'chip waiting', text: 'Waiting for an org admin' }),
              ),
            ),
          )
        : null,
      el(
        'section',
        { class: 'settings-section' },
        el('h3', { text: `Live (${live.notes.length})` }),
        live.notes.length
          ? live.notes.map((n) =>
              noteCard(
                n,
                admin
                  ? el(
                      'span',
                      { class: 'row-end' },
                      n.forgetRequestedBy ? el('button', { class: 'ghost small', type: 'button', text: 'Keep', onclick: () => act(() => api(`/org-notes/${n.id}/keep`, { method: 'POST', body: {} })) }) : null,
                      el('button', { class: 'ghost small danger', type: 'button', text: 'Forget', onclick: () => confirm(`Forget “${n.name}” for every agent?`) && act(() => api(`/org-notes/${encodeURIComponent(n.slug)}`, { method: 'DELETE', body: {} })) }),
                    )
                  : null,
              ),
            )
          : el('p', { class: 'muted small', text: 'No org notes yet.' }),
      ),
      el(
        'form',
        {
          class: 'schedule-form plan-card',
          onsubmit: (event) => {
            event.preventDefault();
            act(() => api('/org-notes', { method: 'POST', body: { name: name.value, description: description.value, type: type.value, body: body.value, source: source.value || null, expires: expires.value || null } }));
          },
        },
        el('h3', { text: admin ? 'New org note' : 'Propose an org note' }),
        el('div', { class: 'schedule-grid' }, el('label', { class: 'field' }, el('span', { class: 'small muted', text: 'Name' }), name), el('label', { class: 'field' }, el('span', { class: 'small muted', text: 'Type' }), type), el('label', { class: 'field' }, el('span', { class: 'small muted', text: 'Expires (statuses)' }), expires), el('label', { class: 'field' }, el('span', { class: 'small muted', text: 'Source' }), source)),
        el('label', { class: 'field' }, el('span', { class: 'small muted', text: 'Index line' }), description),
        el('label', { class: 'field' }, el('span', { class: 'small muted', text: 'Note' }), body),
        el('div', { class: 'row-end' }, el('button', { class: 'primary small', type: 'submit', text: admin ? 'Save' : 'Propose' })),
      ),
    ];
  }

  /* Tool use (#103): which MCP replies are big, which tools fail, which go unused. Org admins only. */

  async function tools() {
    const rows = await api('/tool-usage?days=7');
    if (!rows.length) return el('p', { class: 'muted empty', text: 'No tool calls in the last 7 days.' });
    const kb = (n) => (n < 1024 ? `${n} B` : `${(n / 1024).toFixed(1)} KB`);
    return [
      el('p', { class: 'muted small', text: 'MCP calls by agents in the last 7 days, the biggest total replies first. Counted on this server only.' }),
      el(
        'table',
        { class: 'pf-table' },
        el('thead', {}, el('tr', {}, ['Tool', 'Calls', 'Agents', 'Avg reply', 'Largest', 'Avg time', 'Errors'].map((h) => el('th', { text: h })))),
        el(
          'tbody',
          {},
          rows.map((r) =>
            el(
              'tr',
              {},
              el('td', { class: 'mono', text: r.tool }),
              el('td', { text: String(r.calls) }),
              el('td', { text: String(r.agents) }),
              el('td', { text: kb(r.avgBytes) }),
              el('td', { text: kb(r.maxBytes) }),
              el('td', { text: `${r.avgMs} ms` }),
              el('td', { text: r.errors ? `${r.errors} (${Object.entries(r.errorCodes).map(([k, v]) => `${k} ${v}`).join(', ')})` : '' }),
            ),
          ),
        ),
      ),
    ];
  }

  /* Overview */

  async function overview() {
    const data = await api('/portfolio');
    const t = data.totals;
    const strip = el(
      'div',
      { class: 'pf-totals' },
      [
        [`${t.projects}`, t.projects === 1 ? 'project' : 'projects'],
        [`${t.red}`, 'need attention', t.red ? 'red' : ''],
        [`${t.amber}`, 'to watch', t.amber ? 'amber' : ''],
        [`${t.working}`, 'agent tasks in progress'],
        [`${t.waitingOnYou}`, 'approvals waiting on you', t.waitingOnYou ? 'amber' : ''],
        [money(t.weekCents), 'spent this week'],
      ].map(([value, label, tone]) => el('div', { class: `pf-total ${tone || ''}` }, el('strong', { text: value }), el('span', { class: 'muted small', text: label }))),
    );
    if (!data.projects.length) return [strip, el('p', { class: 'muted empty', text: 'No projects yet.' })];
    return [strip, el('div', { class: 'pf-grid' }, data.projects.map(projectCard))];
  }

  function projectCard(pr) {
    const facts = [
      `${pr.tickets.open} open`,
      pr.tickets.blocked ? `${pr.tickets.blocked} blocked` : null,
      pr.tickets.overdue ? `${pr.tickets.overdue} overdue` : null,
      `${pr.tickets.doneThisWeek} done this week`,
    ].filter(Boolean);
    const agents = [
      pr.agents.working ? `${pr.agents.working} working` : null,
      pr.agents.waiting ? `${pr.agents.waiting} waiting to start` : null,
      pr.agents.stalled ? `${pr.agents.stalled} stalled` : null,
    ].filter(Boolean);
    const spend = `${money(pr.spend.weekCents)} this week · ${money(pr.spend.monthCents)}${pr.spend.budgetCents ? ` of ${money(pr.spend.budgetCents)} (${pr.spend.budgetPercent}%)` : ''} this month`;
    const head = el(
      'div',
      { class: 'pf-head' },
      el('span', { class: `pf-dot ${pr.health}`, title: HEALTH_TEXT[pr.health], 'aria-label': HEALTH_TEXT[pr.health] }),
      pr.role ? el('a', { href: `#~${pr.project}/board`, class: 'pf-name', text: pr.project }) : el('strong', { class: 'pf-name', text: pr.project }),
      pr.role ? el('span', { class: 'chip', text: pr.role }) : el('span', { class: 'chip', text: 'not a member' }),
      el('span', { class: 'spacer' }),
      pr.role
        ? null
        : el('button', { class: 'ghost small', type: 'button', text: 'Join', title: 'Add yourself as a member to read and post', onclick: () => void join(pr.project) }),
    );
    return el(
      'section',
      { class: `pf-card ${pr.health}` },
      head,
      pr.reasons.length ? el('ul', { class: 'pf-reasons' }, pr.reasons.map((r) => el('li', { text: r }))) : el('p', { class: 'muted small', text: 'Nothing needs you here.' }),
      pr.milestone ? milestoneLine(pr.milestone) : null,
      el('p', { class: 'small' }, el('span', { class: 'muted', text: 'Tickets ' }), facts.join(' · ')),
      agents.length ? el('p', { class: 'small' }, el('span', { class: 'muted', text: 'Agents ' }), agents.join(' · ')) : null,
      pr.approvals.waiting
        ? el(
            'p',
            { class: 'small' },
            el('span', { class: 'muted', text: 'Approvals ' }),
            `${pr.approvals.waiting} waiting${pr.approvals.waitingOnYou ? `, ${pr.approvals.waitingOnYou} on you` : ''}${pr.approvals.oldestHours ? ` · oldest ${pr.approvals.oldestHours} h` : ''}`,
          )
        : null,
      pr.ci.length
        ? el(
            'div',
            { class: 'pf-ci' },
            pr.ci.slice(0, 4).map((c) => el('span', { class: `chip ci-${c.state}`, title: c.summary, text: `${c.state === 'failure' ? '✕' : c.state === 'success' ? '✓' : '…'} ${c.source}` })),
          )
        : null,
      el('p', { class: 'small muted', text: spend }),
    );
  }

  async function join(project) {
    try {
      await api(`/projects/${encodeURIComponent(project)}/members`, { method: 'POST', body: { user: me().name, role: 'member' } });
      await onJoin();
      await load();
    } catch (err) {
      notify(err.message);
    }
  }

  function bar(done, total) {
    const fill = el('span', { class: 'progress-fill' });
    fill.style.width = `${total ? Math.round((done / total) * 100) : 0}%`;
    return el('div', { class: 'progress-track' }, fill);
  }

  function milestoneLine(m) {
    return el(
      'div',
      { class: 'pf-milestone' },
      el('span', { class: `chip ms-${m.status}`, text: MILESTONE_TEXT[m.status] }),
      el('span', { class: 'small', text: `${m.name}${m.targetDate ? ` · ${shortDate(m.targetDate)}` : ''} · ${m.done}/${m.total}` }),
      bar(m.done, m.total),
    );
  }

  /* Roadmap */

  async function roadmap() {
    const items = await api('/roadmap');
    if (!items.length) return el('p', { class: 'muted empty', text: 'No milestones yet. Add them under a project’s Tickets → Plan.' });
    return el(
      'ol',
      { class: 'pf-roadmap' },
      items.map((m) =>
        el(
          'li',
          { class: `pf-ms pf-ms-${m.status}` },
          el(
            'div',
            { class: 'pf-ms-head' },
            el('span', { class: 'pf-date', text: m.targetDate ? shortDate(m.targetDate) : 'No date' }),
            el('span', { class: `chip ms-${m.status}`, text: MILESTONE_TEXT[m.status] }),
            el('strong', { text: m.name }),
            el('span', { class: 'muted small', text: m.project }),
            el('span', { class: 'spacer' }),
            el('span', { class: 'small muted', text: `${m.done}/${m.total} done` }),
          ),
          bar(m.done, m.total),
          m.why.length ? el('ul', { class: 'pf-reasons' }, m.why.map((w) => el('li', { text: w }))) : null,
          m.waitsOn.length && !m.why.length
            ? el('p', { class: 'small muted', text: `Waits on ${m.waitsOn.map((w) => `${w.blocker} (${w.blockerProject})`).join(', ')}` })
            : null,
        ),
      ),
    );
  }

  /* Decisions */

  async function decisions() {
    const params = new URLSearchParams();
    if (p.decisionQuery) params.set('q', p.decisionQuery);
    if (p.decisionProject) params.set('project', p.decisionProject);
    const list = await api(`/decisions?${params}`);
    const mine = projects().filter((pr) => pr.role && pr.role !== 'viewer');
    const scope = el(
      'select',
      { 'aria-label': 'Project' },
      isAdmin() ? el('option', { value: '', text: 'All projects (org-wide)' }) : null,
      mine.map((pr) => el('option', { value: pr.name, text: pr.name })),
    );
    const title = el('input', { placeholder: 'What was decided about, like “Database for v2”', maxlength: '200', required: true });
    const decision = el('textarea', { rows: '2', placeholder: 'The decision', required: true });
    const context = el('textarea', { rows: '2', placeholder: 'Why, and what it depends on (optional)' });
    const options = el('textarea', { rows: '2', placeholder: 'Options considered, one per line (optional)' });
    const tags = el('input', { placeholder: 'Tags, comma separated (optional)' });
    const supersedes = el('input', { type: 'hidden' });
    const form = el(
      'form',
      {
        class: 'plan-card schedule-form',
        onsubmit: (event) => {
          event.preventDefault();
          void act(() =>
            api('/decisions', {
              method: 'POST',
              body: {
                project: scope.value || null,
                title: title.value,
                decision: decision.value,
                context: context.value,
                options: options.value.split('\n').map((s) => s.trim()).filter(Boolean),
                tags: tags.value.split(',').map((s) => s.trim()).filter(Boolean),
                supersedes: supersedes.value ? Number(supersedes.value) : undefined,
              },
            }),
          );
        },
      },
      el('h3', { text: 'Record a decision' }),
      el('div', { class: 'schedule-grid' }, el('label', { class: 'field' }, el('span', { class: 'small muted', text: 'Applies to' }), scope), el('label', { class: 'field' }, el('span', { class: 'small muted', text: 'Title' }), title)),
      decision,
      context,
      options,
      tags,
      supersedes,
      el('p', { class: 'small muted', text: 'Agents get the decisions in force with every task, and look them up before reopening a question.' }),
      el('div', { class: 'row-end' }, el('button', { class: 'primary small', type: 'submit', text: 'Record' })),
    );
    if (!mine.length && !isAdmin()) form.hidden = true;

    const search = el('input', { type: 'search', placeholder: 'Search decisions', value: p.decisionQuery || null, 'aria-label': 'Search decisions' });
    let timer = null;
    search.addEventListener('input', () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        p.decisionQuery = search.value.trim();
        void load();
      }, 300);
    });
    const filter = el(
      'select',
      { 'aria-label': 'Filter by project', onchange: (event) => ((p.decisionProject = event.target.value), void load()) },
      el('option', { value: '', text: 'Every project' }),
      projects().map((pr) => el('option', { value: pr.name, text: pr.name, selected: pr.name === p.decisionProject ? true : null })),
    );
    const cards = list.map((d) =>
      el(
        'article',
        { class: 'plan-card pf-decision' },
        el('div', { class: 'pf-ms-head' }, el('strong', { text: `#${d.id} ${d.title}` }), el('span', { class: 'chip', text: d.project ?? 'all projects' }), el('span', { class: 'spacer' }), el('span', { class: 'muted small', text: `${d.decidedBy} · ${new Date(d.at).toLocaleDateString()}` })),
        el('p', { text: d.decision }),
        d.context ? el('p', { class: 'small muted', text: d.context }) : null,
        d.options.length ? el('p', { class: 'small' }, el('span', { class: 'muted', text: 'Considered: ' }), d.options.join(' · ')) : null,
        d.tags.length ? el('div', {}, d.tags.map((t) => el('span', { class: 'chip', text: t }))) : null,
        el('div', { class: 'row-end' },
          el('button', {
            class: 'ghost small',
            type: 'button',
            text: 'Replace with a new decision',
            onclick: () => {
              supersedes.value = String(d.id);
              title.value = d.title;
              if (d.project) scope.value = d.project;
              form.querySelector('h3').textContent = `Replace decision #${d.id}`;
              form.hidden = false;
              decision.focus();
            },
          }),
        ),
      ),
    );
    return [form, el('div', { class: 'pf-filters' }, search, filter), cards.length ? cards : el('p', { class: 'muted empty', text: 'No decisions recorded.' })];
  }

  /* Digest */

  async function digest() {
    const past = await api('/digests');
    const choose = el(
      'select',
      { 'aria-label': 'Digest for', onchange: (event) => ((p.digestProject = event.target.value), void load()) },
      isAdmin() ? el('option', { value: '', text: 'All projects' }) : null,
      projects().map((pr) => el('option', { value: pr.name, text: pr.name, selected: pr.name === p.digestProject ? true : null })),
    );
    if (!isAdmin() && !p.digestProject && projects()[0]) p.digestProject = projects()[0].name;
    const preview = p.digestProject || isAdmin() ? await api(`/digests/preview${p.digestProject ? `?project=${encodeURIComponent(p.digestProject)}` : ''}`) : null;
    const administered = isAdmin() ? [''] : adminOf();
    return [
      administered.length ? await adminDigestCard(administered) : null,
      el('div', { class: 'pf-filters' }, el('span', { class: 'small muted', text: 'This week so far:' }), choose),
      preview ? el('article', { class: 'plan-card pf-digest' }, richText(preview.body)) : null,
      el('h3', { class: 'small', text: 'Past digests' }),
      el('p', { class: 'small muted', text: 'Orco writes one for each project every week (Monday 9:00 UTC by default, ORCO_DIGEST to change) and posts it in the project’s #general.' }),
      past.length
        ? past.map((d) => el('details', { class: 'plan-card' }, el('summary', { text: `${d.project ?? 'All projects'} · ${d.week.slice(0, 10)}` }), richText(d.body)))
        : el('p', { class: 'muted small', text: 'None yet.' }),
    ];
  }

  /**
   * The admin digest (#115): what was done with permissions in a date range, from the audit log.
   * Each line names its audit entry; open one to see it in full.
   */
  async function adminDigestCard(administered) {
    const today = new Date();
    const weekAgo = new Date(today.getTime() - 7 * 86_400_000);
    const from = el('input', { type: 'date', value: p.adFrom ?? weekAgo.toISOString().slice(0, 10), 'aria-label': 'From' });
    const to = el('input', { type: 'date', value: p.adTo ?? today.toISOString().slice(0, 10), 'aria-label': 'To' });
    const where = el('select', { 'aria-label': 'Project' }, administered.map((name) => el('option', { value: name, text: name || 'Every project', selected: name === (p.adProject ?? administered[0]) ? true : null })));
    const show = () => {
      p.adFrom = from.value;
      p.adTo = to.value;
      p.adProject = where.value;
      void load();
    };
    let digest;
    try {
      const q = new URLSearchParams({ from: `${p.adFrom ?? from.value}T00:00:00Z`, to: `${p.adTo ?? to.value}T23:59:59Z`, ...((p.adProject ?? administered[0]) ? { project: p.adProject ?? administered[0] } : {}) });
      digest = await api(`/admin-digest?${q}`);
    } catch (err) {
      return el('p', { class: 'error', text: err.message });
    }
    const openEntry = async (id) => {
      try {
        const entry = await api(`/audit/${id}`);
        alert(JSON.stringify(entry, null, 2));
      } catch (err) {
        notify(err.message);
      }
    };
    return el(
      'section',
      { class: 'plan-card' },
      el('h3', { text: 'Admin digest' }),
      el('div', { class: 'inline-form' }, where, from, el('span', { class: 'muted small', text: 'to' }), to, el('button', { class: 'small', type: 'button', text: 'Show', onclick: show })),
      digest.sections.map((s) =>
        el(
          'div',
          { class: 'ad-section' },
          el('strong', { class: 'small', text: `${s.title} (${s.lines.length})` }),
          s.lines.length
            ? el('ul', { class: 'small' }, s.lines.slice(0, 50).map((l) => el('li', {}, `${new Date(l.at).toLocaleString()}${l.project ? ` · ${l.project}` : ''} · ${l.text} `, el('button', { class: 'link-button', type: 'button', text: `#${l.auditId}`, onclick: () => void openEntry(l.auditId) }))))
            : el('p', { class: 'muted small', text: 'None.' }),
        ),
      ),
    );
  }

  /* Controls */

  async function controls() {
    const admin = isAdmin();
    const administered = admin ? projects().map((pr) => pr.name) : adminOf();
    const [state, agents, groups, setup, models, onyx] = await Promise.all([api('/controls'), api('/agents'), admin ? api('/groups') : Promise.resolve([]), admin ? api('/setup') : Promise.resolve({}), admin ? api('/models') : Promise.resolve(null), admin ? api('/onyx') : Promise.resolve(null)]);
    if (!p.policyProject && administered[0] && !admin) p.policyProject = administered[0];
    const policy = p.policyProject || admin ? await api(`/policy${p.policyProject ? `?project=${encodeURIComponent(p.policyProject)}` : ''}`) : null;
    const scope = admin ? await api('/scope/settings') : null;
    const policyFile = await api('/policy/locked').catch(() => null);
    const rules = admin ? await api('/checked-rules') : null;
    const deploy = administered.length || admin ? await Promise.all([api('/freezes'), api('/deploy-windows')]) : null;
    return [
      policyFile?.file ? el('p', { class: 'small muted plan-card', text: `Managed by the policy file ${policyFile.file}${policyFile.locked.length ? `: ${policyFile.locked.join(', ')} can only change there` : ''}.` }) : null,
      pausesCard(state.pauses, administered, agents), deploy ? deployCard(deploy[0], deploy[1], administered, admin) : null, budgetsCard(state.budgets, administered, agents), scope ? scopeCard(scope) : null, rules ? rulesCard(rules) : null, admin ? updateCard() : null, admin ? peopleCard(setup.proxy ?? (setup.oidc ? { label: setup.oidc.label } : null)) : null, admin ? modelsCard(models) : null, admin ? onyxCard(onyx) : null, policy ? policyCard(policy, administered) : null, admin ? groupsCard(groups) : null];
  }

  /** Freezes and deploy windows (#112): start or end a freeze, and the weekly windows deploys keep to. */
  function deployCard(freezes, windows, administered, admin) {
    const scopes = [...(admin ? [['', 'Every project']] : []), ...administered.map((name) => [name, name])];
    const where = () => el('select', { 'aria-label': 'Where' }, scopes.map(([value, text]) => el('option', { value, text })));
    const fWhere = where();
    const reason = el('input', { placeholder: 'Release weekend: no pushes', maxlength: '200', 'aria-label': 'Reason', required: true });
    const until = el('input', { type: 'datetime-local', 'aria-label': 'Until', required: true });
    const wWhere = where();
    const spec = el('input', { placeholder: 'Wed 13:00-17:00', maxlength: '60', 'aria-label': 'Days and hours', required: true });
    const mode = el('select', { 'aria-label': 'Kind' }, el('option', { value: 'allow', text: 'Deploys only then' }), el('option', { value: 'deny', text: 'Never then' }));
    const refuse = el('input', { type: 'checkbox' });
    const post = (path, body) => async (event) => {
      event.preventDefault();
      try {
        await api(path, { method: 'POST', body: body() });
        void load();
      } catch (err) {
        notify(err.message);
      }
    };
    return el(
      'section',
      { class: 'plan-card' },
      el('h3', { text: 'Freezes and deploy windows' }),
      freezes.length
        ? freezes.map((f) =>
            el('div', { class: 'order-rule small' }, el('strong', { text: f.project ?? 'Every project' }), el('span', { text: ` frozen until ${new Date(f.until).toLocaleString()} · ${f.by}: ${f.reason}` }), el('button', { class: 'ghost small', type: 'button', text: 'End', onclick: () => void api(`/freezes/${f.id}/end`, { method: 'POST', body: {} }).then(() => load(), (err) => notify(err.message)) })),
          )
        : el('p', { class: 'small muted', text: 'No freeze in force.' }),
      el('form', { class: 'inline-form', onsubmit: post('/freezes', () => ({ project: fWhere.value || null, reason: reason.value, until: new Date(until.value).toISOString() })) }, fWhere, reason, until, el('button', { class: 'small', type: 'submit', text: 'Freeze' })),
      el('p', { class: 'small muted', text: `Windows are in ${windows.timeZone} time. Outside one, a deploy or push approval is flagged for the approver, or refused if you tick Refuse.` }),
      windows.windows.map((w) =>
        el('div', { class: 'order-rule small' }, el('span', { text: `${w.project ?? 'Every project'}: ${w.mode === 'allow' ? 'deploys only' : 'never'} ${w.spec}${w.refuse ? ' (refused outside)' : ''}` }), el('button', { class: 'ghost small', type: 'button', text: 'Remove', onclick: () => void api(`/deploy-windows/${w.id}`, { method: 'DELETE' }).then(() => load(), (err) => notify(err.message)) })),
      ),
      el('form', { class: 'inline-form', onsubmit: post('/deploy-windows', () => ({ project: wWhere.value || null, spec: spec.value, mode: mode.value, refuse: refuse.checked })) }, wWhere, mode, spec, el('label', { class: 'check small' }, refuse, 'Refuse'), el('button', { class: 'small', type: 'submit', text: 'Add window' })),
    );
  }

  /** Safe updates (#124): back up, stage, trial-start, switch, or roll back by itself. */
  function updateCard() {
    const log = el('pre', { class: 'small update-log', hidden: true });
    const poll = async () => {
      try {
        const state = await api('/admin/update');
        log.hidden = !state.log;
        log.textContent = state.log;
        if (state.log && !/Updated |Rolling back|Already at|stopped|Rolled back/.test(state.log)) setTimeout(poll, 3000);
      } catch {
        // The server is restarting: try again shortly.
        setTimeout(poll, 3000);
      }
    };
    void poll();
    return el(
      'section',
      { class: 'plan-card' },
      el('h3', { text: 'Update Orco' }),
      el('p', { class: 'small muted', text: 'Backs up the database, builds the new version beside this one, migrates a copy and trial-starts it, then switches; if the new version does not come up healthy, it goes back to this one and the backup by itself. Needs a git checkout and ORCO_RESTART_CMD on the server.' }),
      el('div', { class: 'row-end' }, el('button', { class: 'primary small', type: 'button', text: 'Update', onclick: () => confirm('Update Orco now? It restarts once the new version passes its trial.') && void api('/admin/update', { method: 'POST', body: {} }).then(() => setTimeout(poll, 1000), (err) => notify(err.message)) })),
      log,
    );
  }

  /** Checked rules (#113): patterns that block plans and approvals, and flag code in messages. Org admins. */
  function rulesCard(rules) {
    const save = (body) => api('/checked-rules', { method: 'POST', body }).then(() => load(), (err) => notify(err.message));
    const name = el('input', { placeholder: 'No public S3 buckets', maxlength: '80', 'aria-label': 'Rule name', required: true });
    const pattern = el('input', { placeholder: 'acl\\s*=\\s*"public-read"', maxlength: '300', 'aria-label': 'Pattern (a regular expression)', required: true });
    const owner = el('input', { placeholder: 'owner (optional)', maxlength: '32', 'aria-label': 'Owner' });
    return el(
      'section',
      { class: 'plan-card' },
      el('h3', { text: 'Checked rules' }),
      el('p', { class: 'small muted', text: 'A match blocks a plan or an approval request, naming the rule and telling its owner; in a message\'s code or diff it is flagged.' }),
      rules.map((r) => {
        const on = el('input', { type: 'checkbox', checked: r.enabled, 'aria-label': `${r.name} on` });
        on.addEventListener('change', () => void save({ id: r.id, enabled: on.checked }));
        return el(
          'div',
          { class: 'order-rule small' },
          el('label', { class: 'check' }, on, el('strong', { text: r.name })),
          el('span', { class: 'muted', text: ` · ${r.scopes.join(', ')}${r.owner ? ` · owner ${r.owner}` : ''}` }),
          el('code', { class: 'rule-pattern', text: r.pattern }),
        );
      }),
      el(
        'form',
        {
          class: 'inline-form',
          onsubmit: (event) => {
            event.preventDefault();
            void save({ name: name.value, pattern: pattern.value, regex: true, scopes: ['plan', 'approval', 'message'], owner: owner.value || null });
          },
        },
        name,
        pattern,
        owner,
        el('button', { class: 'small', type: 'submit', text: 'Add rule' }),
      ),
    );
  }

  /** The scope gate (#108): whether new projects start in Scope, and the template's sections. Org admins. */
  function scopeCard(scope) {
    const gate = el('input', { type: 'checkbox', checked: scope.gateNewProjects });
    const sections = el('textarea', { rows: String(Math.min(scope.sections.length + 1, 12)), 'aria-label': 'Scope sections, one per line' });
    sections.value = scope.sections.join('\n');
    const save = async () => {
      try {
        await api('/scope/settings', { method: 'POST', body: { gateNewProjects: gate.checked, sections: sections.value.split('\n') } });
        notify('Scope settings saved');
        void load();
      } catch (err) {
        notify(err.message);
      }
    };
    return el(
      'section',
      { class: 'plan-card' },
      el('h3', { text: 'Scope before build' }),
      el('p', { class: 'small muted', text: 'A project in Scope keeps build tickets in Backlog, and refuses repos, stacks and deploys, until scoping/SCOPE.md covers every section below and a project admin approves it.' }),
      el('label', { class: 'check small' }, gate, 'New projects start in Scope'),
      el('label', { class: 'field' }, el('span', { class: 'small muted', text: 'Sections of SCOPE.md, one per line (empty: the built-in ones)' }), sections),
      el('div', { class: 'row-end' }, el('button', { class: 'primary small', type: 'button', text: 'Save', onclick: () => void save() })),
    );
  }

  /**
   * AI models for agents that run on Orco: an OpenAI-compatible API, its key (stored encrypted) and
   * prices. These addresses are the only places the server calls out to.
   */
  function modelsCard(models) {
    const field = (placeholder, label, props = {}) => el('input', { placeholder, 'aria-label': label, ...props });
    const name = field('Name, like openai', 'Provider name');
    const url = field('API address, like https://api.openai.com/v1', 'API address');
    const model = field('Model, like gpt-4o-mini', 'Model');
    const key = field('API key', 'API key', { type: 'password', autocomplete: 'off' });
    const priceIn = field('$ per 1M input tokens', 'Input price', { inputmode: 'decimal' });
    const priceOut = field('$ per 1M output tokens', 'Output price', { inputmode: 'decimal' });
    const shared = el('input', { type: 'checkbox', checked: true });
    const save = () =>
      void act(() =>
        api('/models', {
          method: 'POST',
          body: { name: name.value.trim(), base_url: url.value.trim(), model: model.value.trim(), api_key: key.value, price_in: priceIn.value.trim(), price_out: priceOut.value.trim(), shared: shared.checked },
        }),
      );
    return el(
      'section',
      { class: 'plan-card' },
      el('h3', { text: 'AI models' }),
      el('p', {
        class: 'small muted',
        text: 'For agents that run on Orco, made by people in the browser: any OpenAI-compatible API (OpenAI, OpenRouter, Ollama, vLLM, LM Studio). Keys are stored encrypted. Orco calls only these addresses.',
      }),
      models?.secrets
        ? null
        : el('p', { class: 'small warn-text', text: 'Turn on ORCO_SECRETS_KEY on the server first: model keys are stored encrypted with it.' }),
      models?.providers?.length
        ? el(
            'ul',
            { class: 'pf-list' },
            models.providers.map((m) =>
              el(
                'li',
                {},
                el('strong', { text: m.name }),
                el('span', { class: 'muted small', text: ` ${m.model} at ${m.baseUrl}${m.hasKey ? '' : ' · no key'}${m.shared ? ' · everyone' : ' · org admins only'}` }),
                el('span', { class: 'spacer' }),
                el('button', { class: 'ghost small', type: 'button', text: 'Remove', onclick: () => confirm(`Remove ${m.name}?`) && void act(() => api(`/models/${encodeURIComponent(m.name)}`, { method: 'DELETE', body: {} })) }),
              ),
            ),
          )
        : el('p', { class: 'small', text: 'No models yet.' }),
      models?.secrets
        ? el(
            'div',
            { class: 'pf-stack' },
            el('div', { class: 'pf-row' }, name, model),
            el('div', { class: 'pf-row' }, url),
            el('div', { class: 'pf-row' }, key, priceIn, priceOut),
            el('label', { class: 'check small' }, shared, 'Everyone may make agents on it (otherwise org admins only)'),
            el('div', { class: 'row-end' }, el('button', { class: 'small', type: 'button', text: 'Save model', onclick: save })),
          )
        : null,
    );
  }

  /**
   * Onyx knowledge search: one Onyx server and its API key (stored encrypted). People search it from
   * the search box, agents with search_knowledge. Orco calls it only when someone searches.
   */
  function onyxCard(onyx) {
    const current = onyx?.settings;
    const url = el('input', { placeholder: 'Onyx address, like https://onyx.example.com', 'aria-label': 'Onyx address', value: current?.baseUrl ?? '' });
    const key = el('input', { placeholder: current ? 'API key (leave empty to keep it)' : 'API key', 'aria-label': 'Onyx API key', type: 'password', autocomplete: 'off' });
    const persona = el('input', { placeholder: 'Onyx agent id (optional)', 'aria-label': 'Onyx agent id', inputmode: 'numeric', value: current?.persona ?? '' });
    const sets = el('input', { placeholder: 'Document sets, comma-separated (optional)', 'aria-label': 'Document sets', value: current?.documentSets.join(', ') ?? '' });
    const sources = el('input', { placeholder: 'Sources, like slack, google_drive (optional)', 'aria-label': 'Sources', value: current?.sources.join(', ') ?? '' });
    const brief = el('input', { type: 'checkbox', checked: current ? current.brief : true });
    const save = () =>
      void act(() =>
        api('/onyx', {
          method: 'POST',
          body: { base_url: url.value.trim(), api_key: key.value, persona: persona.value.trim(), document_sets: sets.value, sources: sources.value, brief: brief.checked },
        }),
      );
    return el(
      'section',
      { class: 'plan-card' },
      el('h3', { text: 'Onyx knowledge search' }),
      el('p', {
        class: 'small muted',
        text: 'Connect Onyx so people and agents can search your company’s documents (Slack, Drive, Confluence and the rest) from Orco. Everyone signed in can search what this key sees, so limit it with an Onyx agent, document sets or sources. Orco calls Onyx only when someone searches.',
      }),
      onyx?.secrets ? null : el('p', { class: 'small warn-text', text: 'Turn on ORCO_SECRETS_KEY on the server first: the Onyx key is stored encrypted with it.' }),
      current
        ? el(
            'p',
            { class: 'small' },
            el('strong', { text: 'Connected' }),
            el('span', { class: 'muted', text: ` to ${current.baseUrl} by ${current.updatedBy}` }),
            ' ',
            el('button', { class: 'ghost small', type: 'button', text: 'Disconnect', onclick: () => confirm('Disconnect Onyx? Searches stop until it is connected again.') && void act(() => api('/onyx', { method: 'DELETE', body: {} })) }),
          )
        : null,
      onyx?.secrets
        ? el(
            'div',
            { class: 'pf-stack' },
            el('div', { class: 'pf-row' }, url),
            el('div', { class: 'pf-row' }, key, persona),
            el('div', { class: 'pf-row' }, sets, sources),
            el('label', { class: 'check small' }, brief, 'When an agent accepts a task, give it the top Onyx results for that task'),
            el('p', { class: 'small muted', text: 'Make the key in Onyx under Admin → API Keys; a limited key needs only Search (read).' }),
            el('div', { class: 'row-end' }, el('button', { class: 'small', type: 'button', text: current ? 'Save' : 'Connect Onyx', onclick: save })),
          )
        : null,
    );
  }

  /** Org admins invite people with a sign-in link, or by their email when Orco sits behind a sign-in proxy. */
  function peopleCard(proxy) {
    const email = proxy ? el('input', { type: 'email', placeholder: `Their ${proxy.label} email (optional)`, 'aria-label': `Their ${proxy.label} email` }) : null;
    const name = el('input', { placeholder: 'Their name, like ana', pattern: '[a-z0-9][a-z0-9\\-]{0,31}', 'aria-label': 'Name of the person to add' });
    const result = el('div', { class: 'people-result' });
    const copyRow = (text, label) =>
      el(
        'div',
        { class: 'copy-block' },
        el('pre', {}, el('code', { text })),
        el('button', {
          class: 'small',
          type: 'button',
          text: label,
          onclick: (event) =>
            void navigator.clipboard.writeText(text).then(
              () => (event.target.textContent = 'Copied'),
              () => (event.target.textContent = 'Select and copy'),
            ),
        }),
      );
    const showLink = (who, code, intro) => {
      result.replaceChildren(
        el('p', { class: 'small', text: intro }),
        copyRow(`${new URL('.', location.href).href}#signin=${code}`, 'Copy link'),
        el('p', { class: 'small muted', text: `It works once, within 7 days. Send it to ${who} privately: whoever opens it first is signed in as ${who}.` }),
      );
      // A code the invitee's phone can scan, built from an address it can reach (#137).
      void phoneLinkBlock({ el, api }, `#signin=${code}`).then((block) => result.append(block));
    };
    const add = async () => {
      try {
        const person = await api('/users', { method: 'POST', body: { name: name.value.trim(), ...(email?.value.trim() ? { email: email.value.trim() } : {}) } });
        name.value = '';
        if (email?.value.trim()) {
          result.replaceChildren(
            el('p', { class: 'small', text: `${person.name} can now open ${new URL('.', location.href).href} and sign in with ${proxy.label} as ${email.value.trim()}. Nothing to send but the address.` }),
          );
          email.value = '';
          return;
        }
        showLink(person.name, person.signin.code, `Send ${person.name} this link. It signs them in; then they can add their own agents.`);
        result.append(
          el(
            'details',
            { class: 'small' },
            el('summary', { text: 'Their token, for the command line (shown once)' }),
            copyRow(person.token, 'Copy token'),
          ),
          el('p', { class: 'small muted', text: 'Add them to projects from each project’s Add member button.' }),
        );
      } catch (err) {
        notify(err.message);
      }
    };
    return el(
      'section',
      { class: 'plan-card' },
      el('h3', { text: 'People' }),
      el('p', { class: 'small muted', text: 'Add someone to this Orco. They see only the projects you add them to.' }),
      el('div', { class: 'pf-row' }, name, email, el('button', { class: 'small', type: 'button', text: 'Add person', onclick: () => void add() })),
      result,
      el('p', { class: 'small muted', text: 'Someone lost access? Whoever runs the server makes them a new sign-in link with orco user link <name>.' }),
    );
  }

  function pausesCard(pauses, administered, agents) {
    const reason = el('input', { placeholder: 'Why (shown to everyone affected)', maxlength: '300' });
    const target = el(
      'select',
      { 'aria-label': 'What to pause' },
      isAdmin() ? el('option', { value: 'all:', text: 'Every agent on this server' }) : null,
      administered.map((name) => el('option', { value: `project:${name}`, text: `Agents in ${name}` })),
      agents.map((a) => el('option', { value: `agent:${a.name}`, text: a.name })),
    );
    const pause = () => {
      const [scope, name] = target.value.split(':');
      void act(() => api('/pauses', { method: 'POST', body: { scope, target: name || null, reason: reason.value } }));
    };
    return el(
      'section',
      { class: 'plan-card' },
      el('h3', { text: 'Kill switch' }),
      el('p', { class: 'small muted', text: 'A pause stops running agents (their tasks fail with the reason) and starts nothing new until you resume. Paused agents can still close their tasks.' }),
      pauses.length
        ? el(
            'ul',
            { class: 'pf-list' },
            pauses.map((x) =>
              el(
                'li',
                {},
                el('strong', { class: 'danger-text', text: x.scope === 'all' ? 'All agents' : x.scope === 'project' ? `Agents in ${x.target}` : x.target }),
                el('span', { class: 'muted small', text: ` paused by ${x.by}${x.reason ? `: ${x.reason}` : ''}` }),
                el('span', { class: 'spacer' }),
                el('button', { class: 'small', type: 'button', text: 'Resume', onclick: () => void act(() => api('/pauses/resume', { method: 'POST', body: { scope: x.scope, target: x.target } })) }),
              ),
            ),
          )
        : el('p', { class: 'small', text: 'Nothing is paused.' }),
      target.options.length ? el('div', { class: 'pf-row' }, target, reason, el('button', { class: 'small danger', type: 'button', text: 'Pause', onclick: pause })) : null,
    );
  }

  function budgetsCard(budgets, administered, agents) {
    const target = el(
      'select',
      { 'aria-label': 'Budget for' },
      administered.map((name) => el('option', { value: `project:${name}`, text: `Project ${name}` })),
      agents.map((a) => el('option', { value: `agent:${a.name}`, text: `Agent ${a.name}` })),
    );
    const amount = el('input', { placeholder: 'Monthly cap, like 200', inputmode: 'decimal', 'aria-label': 'Monthly cap in dollars' });
    const save = () => {
      const [scope, name] = target.value.split(':');
      const cents = dollars(amount.value);
      if (cents === null) return notify('Enter a dollar amount');
      void act(() => api('/budgets', { method: 'POST', body: { scope, target: name, monthly_cents: cents } }));
    };
    return el(
      'section',
      { class: 'plan-card' },
      el('h3', { text: 'Monthly budgets' }),
      el('p', { class: 'small muted', text: 'Spend counts what agents’ tasks cost this calendar month. At 80% you are told once; past the cap, new tasks wait for your approval.' }),
      budgets.length
        ? el(
            'ul',
            { class: 'pf-list' },
            budgets.map((b) =>
              el(
                'li',
                {},
                el('span', { text: `${b.scope === 'project' ? 'Project' : 'Agent'} ${b.target}` }),
                el('span', { class: `small ${b.percent >= 100 ? 'danger-text' : b.percent >= 80 ? 'warn-text' : 'muted'}`, text: ` ${money(b.spentCents)} of ${money(b.monthlyCents)} (${b.percent}%)` }),
                // Pace (#106): what is left, where an even month would be, and when it runs out at this rate.
                el('span', { class: `small ${b.runsOutOn ? 'warn-text' : 'muted'}`, text: ` · ${money(b.remainingCents)} left · even pace ${money(b.evenCents)}${b.runsOutOn ? ` · at this pace it runs out on ${b.runsOutOn}` : ''}` }),
                el('span', { class: 'spacer' }),
                el('button', { class: 'ghost small', type: 'button', text: 'Remove', onclick: () => void act(() => api('/budgets', { method: 'POST', body: { scope: b.scope, target: b.target, monthly_cents: null } })) }),
              ),
            ),
          )
        : el('p', { class: 'small', text: 'No budgets set.' }),
      target.options.length ? el('div', { class: 'pf-row' }, target, amount, el('button', { class: 'small', type: 'button', text: 'Set', onclick: save })) : null,
    );
  }

  function policyCard(view, administered) {
    const editing = p.policyProject ? view.project : view.org;
    const lines = (list) => (list ?? []).join('\n');
    const rules = el('textarea', { rows: '3', placeholder: 'One rule per line, like “Never push to main”', text: lines(editing?.rules) });
    const approvals = el('textarea', { rows: '2', placeholder: 'Actions that need a person first, one per line, like “deploy to production”', text: lines(editing?.approvalRequired) });
    const num = (value, placeholder) => el('input', { inputmode: 'numeric', placeholder, value: value ?? null });
    const defMinutes = num(editing?.defaultTaskMinutes, 'minutes');
    const maxMinutes = num(editing?.maxTaskMinutes, 'minutes');
    const defDollars = el('input', { inputmode: 'decimal', placeholder: '$', value: editing?.defaultTaskCents ? (editing.defaultTaskCents / 100).toFixed(2) : null });
    const maxDollars = el('input', { inputmode: 'decimal', placeholder: '$', value: editing?.maxTaskCents ? (editing.maxTaskCents / 100).toFixed(2) : null });
    const allowed = el('input', { placeholder: 'Agent names, comma separated (empty: any agent)', value: editing?.allowedAgents?.join(', ') ?? null });
    const scope = el(
      'select',
      { 'aria-label': 'Policy for', onchange: (event) => ((p.policyProject = event.target.value), void load()) },
      isAdmin() ? el('option', { value: '', text: 'Whole server (org)' }) : null,
      administered.map((name) => el('option', { value: name, text: `Project ${name}`, selected: name === p.policyProject ? true : null })),
    );
    const int = (input) => (input.value.trim() ? Number(input.value.trim()) : null);
    const save = () =>
      void act(() =>
        api('/policy', {
          method: 'POST',
          body: {
            project: p.policyProject || null,
            policy: {
              rules: rules.value.split('\n'),
              approval_required: approvals.value.split('\n'),
              default_task_minutes: int(defMinutes),
              max_task_minutes: int(maxMinutes),
              default_task_cents: defDollars.value.trim() ? dollars(defDollars.value) : null,
              max_task_cents: maxDollars.value.trim() ? dollars(maxDollars.value) : null,
              allowed_agents: allowed.value.trim() ? allowed.value.split(',').map((s) => s.trim()).filter(Boolean) : null,
            },
          },
        }),
      );
    const effective = view.effective;
    return el(
      'section',
      { class: 'plan-card' },
      el('div', { class: 'pf-ms-head' }, el('h3', { text: 'Policy' }), el('span', { class: 'spacer' }), scope),
      el('p', {
        class: 'small muted',
        text: p.policyProject
          ? 'Adds to the org policy and can only make it stricter. Agents get these rules with every task here.'
          : 'Applies to every project. Projects can add to it but not loosen it.',
      }),
      el('label', { class: 'field' }, el('span', { class: 'small muted', text: 'Rules for agents' }), rules),
      el('label', { class: 'field' }, el('span', { class: 'small muted', text: 'Ask a person before' }), approvals),
      el(
        'div',
        { class: 'schedule-grid' },
        el('label', { class: 'field' }, el('span', { class: 'small muted', text: 'Default task time' }), defMinutes),
        el('label', { class: 'field' }, el('span', { class: 'small muted', text: 'Most a task may take' }), maxMinutes),
        el('label', { class: 'field' }, el('span', { class: 'small muted', text: 'Default task cost' }), defDollars),
        el('label', { class: 'field' }, el('span', { class: 'small muted', text: 'Most a task may cost' }), maxDollars),
      ),
      el('label', { class: 'field' }, el('span', { class: 'small muted', text: 'Only these agents may take tasks' }), allowed),
      p.policyProject && (effective.rules.length || effective.approvalRequired.length)
        ? el('p', { class: 'small muted', text: `In force here: ${[...effective.rules, ...effective.approvalRequired.map((a) => `ask before: ${a}`)].join(' · ')}` })
        : null,
      el('div', { class: 'row-end' }, view.updatedBy ? el('span', { class: 'muted small', text: `Last set by ${view.updatedBy}` }) : null, el('button', { class: 'primary small', type: 'button', text: 'Save policy', onclick: save })),
    );
  }

  function groupsCard(groups) {
    const name = el('input', { placeholder: 'backend', maxlength: '32', 'aria-label': 'Group name' });
    const members = el('input', { placeholder: 'ana, ben', 'aria-label': 'Members' });
    return el(
      'section',
      { class: 'plan-card' },
      el('h3', { text: 'Groups' }),
      el('p', { class: 'small muted', text: 'Add a group to many projects at once from a project’s Members panel, and @mention it to ping everyone in it.' }),
      groups.length
        ? el(
            'ul',
            { class: 'pf-list' },
            groups.map((g) => {
              const add = el('input', { placeholder: 'add someone', 'aria-label': `Add to ${g.name}` });
              return el(
                'li',
                { class: 'pf-group' },
                el('strong', { text: `@${g.name}` }),
                el('span', { class: 'small', text: ` ${g.members.join(', ') || 'no one yet'}` }),
                el('span', { class: 'muted small', text: g.projects.length ? ` · in ${g.projects.map((x) => `${x.project} (${x.role})`).join(', ')}` : '' }),
                el('span', { class: 'spacer' }),
                add,
                el('button', { class: 'ghost small', type: 'button', text: 'Add', onclick: () => void act(() => api(`/groups/${encodeURIComponent(g.name)}/members`, { method: 'POST', body: { user: add.value.trim() } })) }),
                el('button', {
                  class: 'ghost small danger',
                  type: 'button',
                  text: 'Delete',
                  onclick: () => confirm(`Delete group ${g.name}? Its people lose the access it gave them.`) && void act(() => api(`/groups/${encodeURIComponent(g.name)}`, { method: 'DELETE' })),
                }),
              );
            }),
          )
        : el('p', { class: 'small', text: 'No groups yet.' }),
      el(
        'div',
        { class: 'pf-row' },
        name,
        members,
        el('button', {
          class: 'small',
          type: 'button',
          text: 'Create group',
          onclick: () => void act(() => api('/groups', { method: 'POST', body: { name: name.value.trim(), members: members.value.split(',').map((s) => s.trim()).filter(Boolean) } })),
        }),
      ),
    );
  }

  return { show, onEvent };
}
