// The view across projects: health per project, the roadmap, decisions, weekly digests, and the
// controls for running many projects (pauses, budgets, policies, groups). DOM built with el() only.

const TABS = [
  ['overview', 'Overview'],
  ['roadmap', 'Roadmap'],
  ['decisions', 'Decisions'],
  ['digest', 'Digest'],
  ['controls', 'Controls'],
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
      const view = await { overview, roadmap, decisions, digest, controls }[p.tab]();
      body.replaceChildren(...[view].flat(3).filter(Boolean));
    } catch (err) {
      body.replaceChildren(el('p', { class: 'error', text: err.message }));
    }
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
    return [
      el('div', { class: 'pf-filters' }, el('span', { class: 'small muted', text: 'This week so far:' }), choose),
      preview ? el('article', { class: 'plan-card pf-digest' }, richText(preview.body)) : null,
      el('h3', { class: 'small', text: 'Past digests' }),
      el('p', { class: 'small muted', text: 'Orco writes one for each project every week (Monday 9:00 UTC by default, ORCO_DIGEST to change) and posts it in the project’s #general.' }),
      past.length
        ? past.map((d) => el('details', { class: 'plan-card' }, el('summary', { text: `${d.project ?? 'All projects'} · ${d.week.slice(0, 10)}` }), richText(d.body)))
        : el('p', { class: 'muted small', text: 'None yet.' }),
    ];
  }

  /* Controls */

  async function controls() {
    const admin = isAdmin();
    const administered = admin ? projects().map((pr) => pr.name) : adminOf();
    const [state, agents, groups, setup, models] = await Promise.all([api('/controls'), api('/agents'), admin ? api('/groups') : Promise.resolve([]), admin ? api('/setup') : Promise.resolve({}), admin ? api('/models') : Promise.resolve(null)]);
    if (!p.policyProject && administered[0] && !admin) p.policyProject = administered[0];
    const policy = p.policyProject || admin ? await api(`/policy${p.policyProject ? `?project=${encodeURIComponent(p.policyProject)}` : ''}`) : null;
    return [pausesCard(state.pauses, administered, agents), budgetsCard(state.budgets, administered, agents), admin ? peopleCard(setup.proxy ?? (setup.oidc ? { label: setup.oidc.label } : null)) : null, admin ? modelsCard(models) : null, policy ? policyCard(policy, administered) : null, admin ? groupsCard(groups) : null];
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
    const showLink = (who, code, intro) =>
      result.replaceChildren(
        el('p', { class: 'small', text: intro }),
        copyRow(`${location.origin}/#signin=${code}`, 'Copy link'),
        el('p', { class: 'small muted', text: `It works once, within 7 days. Send it to ${who} privately: whoever opens it first is signed in as ${who}.` }),
      );
    const add = async () => {
      try {
        const person = await api('/users', { method: 'POST', body: { name: name.value.trim(), ...(email?.value.trim() ? { email: email.value.trim() } : {}) } });
        name.value = '';
        if (email?.value.trim()) {
          result.replaceChildren(
            el('p', { class: 'small', text: `${person.name} can now open ${location.origin} and sign in with ${proxy.label} as ${email.value.trim()}. Nothing to send but the address.` }),
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
