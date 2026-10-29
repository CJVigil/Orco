// Getting started: first-run setup, adding and connecting agents, approving a computer, asking an
// agent for something, the getting-started checklist, and plain explanations. DOM built with el() only.

const STEP_ACTIONS = {
  project: 'New project',
  agent: 'Add an agent',
  connect: 'Connect a computer',
  task: 'Ask an agent',
};

const TOOL_NAMES = {
  claude: 'Claude Code',
  codex: 'Codex',
  gemini: 'Gemini CLI',
  qwen: 'Qwen Code',
  opencode: 'OpenCode',
  goose: 'Goose',
  cursor: 'Cursor CLI',
  hermes: 'Hermes Agent',
  aider: 'Aider',
};

const TEMPLATES = [
  ['Fix a bug', 'Fix this bug: <what goes wrong, where, and how to make it happen>.\nAdd a test that fails before the fix. Open a pull request and put the link in your result.'],
  ['Review a pull request', 'Review <link to the pull request>: look for bugs, missing tests and unclear code. Comment on it, and sum up what you found.'],
  ['Look into something', 'Find out why <the problem>. Do not change anything yet: report what you found and what you would do about it.'],
  ['Small change', 'Make this change: <what>. Keep it small, run the tests, and open a pull request.'],
  ['Write docs', 'Write documentation for <the feature>: who it is for, how to use it, and an example. Put it in <file>.'],
];

const GLOSSARY = [
  ['Projects and rooms', 'A project holds the work for one thing you are building, with its people, agents, rooms and tickets. Rooms are chats; every project starts with #general.'],
  ['Agents', 'An AI helper like Claude Code or Codex that belongs to a person. It sees the projects its owner is in, and works when it is given a task.'],
  ['Connecting a computer', 'Agents run on your own computer, where your code is. One command there (Connect a computer shows it) links it to Orco; from then on Orco starts your agents there when they get work.'],
  ['Tasks', 'A request to one agent ("fix the login bug"). The agent accepts it, reports progress, may ask you something, and finishes with a short note and links. Rate the result with ▲ or ▼ so it learns.'],
  ['Tickets', 'The project’s to-do list, on a board. Assign a ticket to an agent and it becomes a task; the ticket moves along as the agent works.'],
  ['Mentions', '@name pings someone. @all pings every person in the room. Agents only start work from tasks, not from plain mentions.'],
  ['Approvals', 'Before something risky (a deploy, a merge, spending money) an agent asks its owner, and waits for Approve or Deny.'],
  ['Questions', 'When an agent needs something only you know, it asks instead of guessing. Answer in the thread and it carries on.'],
  ['Locks', 'An agent takes a lock (like "deploy:prod") before touching something shared, so two agents never do it at once.'],
  ['Trail', 'Everything an agent did on a task: each run, how long it took, what it cost, and a log of its steps.'],
  ['Budgets and pauses', 'Limit what a task, an agent or a project may spend, and stop agents at once if something looks wrong (Portfolio → Controls).'],
];

export function createGuide(ctx) {
  const { api, el, $, me, room, openPanel, panel, loadStructure, newProject, showMyAgents } = ctx;
  const origin = location.origin;

  /** The one command that joins a computer: through npx when this server hands out Orco, so nothing needs installing. */
  let client;
  async function joinCommand() {
    client ??= api('/client').catch(() => ({ package: null }));
    const info = await client;
    return info.package ? `npx -y ${origin}${info.package} connect ${origin}` : `orco connect ${origin}`;
  }

  /** The command to copy, with what it needs. */
  async function joinBlock() {
    const command = await joinCommand();
    return [
      copyBlock(command),
      el('p', {
        class: 'small muted',
        text: command.startsWith('npx')
          ? 'Needs Node.js 22.13 or newer (nodejs.org). Nothing else to install.'
          : 'Needs the orco command there: from a copy of the Orco repository, npm ci && npm run build && npm link.',
      }),
    ];
  }

  /* Small builders */

  function modal(title, ...content) {
    const dialog = el('dialog', { class: 'ask guide' });
    const close = () => dialog.close();
    dialog.append(
      el(
        'div',
        { class: 'guide-body' },
        el('div', { class: 'guide-head' }, el('h2', { text: title }), el('button', { class: 'ghost icon', type: 'button', 'aria-label': 'Close', text: '×', onclick: close })),
        ...content.flat().filter(Boolean),
      ),
    );
    dialog.addEventListener('close', () => dialog.remove());
    document.body.append(dialog);
    dialog.showModal();
    return dialog;
  }

  function copyBlock(text, label = 'Copy') {
    const button = el('button', {
      class: 'small',
      type: 'button',
      text: label,
      onclick: async () => {
        try {
          await navigator.clipboard.writeText(text);
          button.textContent = 'Copied';
          setTimeout(() => (button.textContent = label), 1500);
        } catch {
          button.textContent = 'Select and copy';
        }
      },
    });
    return el('div', { class: 'copy-block' }, el('pre', {}, el('code', { text })), button);
  }

  const error = () => el('p', { class: 'error', role: 'alert', hidden: true });
  const showError = (node, err) => {
    node.textContent = err.message;
    node.hidden = false;
  };

  /* First run */

  /** The screen the first person sees on a new server: make an account with the code from the server log. */
  function showSetup(code, onDone) {
    const card = $('login-form');
    const name = el('input', { required: true, autocomplete: 'username', placeholder: 'carlos', pattern: '[a-z0-9][a-z0-9\\-]{0,31}', 'aria-label': 'Your name' });
    const setupCode = el('input', { required: true, value: code || null, autocomplete: 'off', 'aria-label': 'Setup code' });
    const problem = error();
    const form = el(
      'form',
      {
        class: 'login-card',
        onsubmit: async (event) => {
          event.preventDefault();
          try {
            const done = await api('/setup', { method: 'POST', body: { code: setupCode.value.trim(), name: name.value.trim() } });
            history.replaceState(null, '', location.pathname);
            form.replaceChildren(
              el('h1', { text: `Welcome, ${done.name}` }),
              el('p', { class: 'muted small', text: 'You are signed in here. This is your personal token, shown once: keep it in a password manager to sign in from another browser or with the orco command.' }),
              copyBlock(done.token),
              el('button', { class: 'primary', type: 'button', text: 'Continue', onclick: () => void onDone() }),
            );
          } catch (err) {
            showError(problem, err);
          }
        },
      },
      el('div', { class: 'brand' }, el('span', { class: 'logo', 'aria-hidden': 'true' }), 'Orco'),
      el('h1', { text: 'Set up Orco' }),
      el('p', { class: 'muted small', text: 'No one has an account yet. Make yours: you will run this server, and can add people and agents from here.' }),
      el('label', { text: 'Your name' }),
      name,
      el('p', { class: 'muted small', text: 'Lowercase letters, digits and dashes.' }),
      el('label', { text: 'Setup code' }),
      setupCode,
      el('p', { class: 'muted small', text: 'Printed in the server log when Orco started. It is filled in if you opened the link from there.' }),
      problem,
      el('button', { class: 'primary', type: 'submit', text: 'Create my account' }),
    );
    card.replaceWith(form);
    form.id = 'login-form';
    (code ? name : setupCode).focus();
  }

  /* Signing in */

  /** A one-time link that signs you in on another device (15 minutes). */
  async function signInLink() {
    const link = await api('/signin-links', { method: 'POST', body: {} });
    return { url: `${origin}/#signin=${link.code}`, expiresAt: link.expiresAt };
  }

  async function showOtherDevice() {
    try {
      const link = await signInLink();
      modal(
        'Sign in on another device',
        el('p', { class: 'small', text: 'Open this link on your phone or other computer. It signs you in there once, within 15 minutes.' }),
        copyBlock(link.url, 'Copy link'),
        el('p', { class: 'small muted', text: 'Keep it to yourself: anyone who opens it first is signed in as you.' }),
      );
    } catch (err) {
      modal('Sign in on another device', el('p', { class: 'error', text: err.message }));
    }
  }

  /** The first screen after someone opens their invite. */
  function showWelcome(name) {
    modal(
      `Welcome to Orco, ${name}`,
      el('p', { class: 'small', text: 'You are signed in. Orco is a team chat where people and their AI agents work together: you talk in rooms, give agents tasks, and they report back here.' }),
      el('p', { class: 'small muted', text: 'To bring your own AI helper (like Claude Code or Codex), add an agent and connect the computer it works on. Or look around first.' }),
      el(
        'div',
        { class: 'row-end' },
        el('button', { class: 'ghost', type: 'button', text: 'Look around', onclick: (event) => event.target.closest('dialog').close() }),
        el('button', {
          class: 'primary',
          type: 'button',
          text: 'Add my agent',
          onclick: (event) => {
            event.target.closest('dialog').close();
            addAgent();
          },
        }),
      ),
    );
  }

  /** Link the login the sign-in proxy vouches for (Google, say) to your account. */
  function offerLinkLogin(proxy) {
    const problem = error();
    modal(
      `Sign in with ${proxy.label} from now on?`,
      el('p', { class: 'small', text: `You are signed in to ${proxy.label} as ${proxy.identity}. Link it to ${me().name}, and opening Orco signs you in, without links or tokens.` }),
      problem,
      el(
        'div',
        { class: 'row-end' },
        el('button', { class: 'ghost', type: 'button', text: 'Not now', onclick: (event) => event.target.closest('dialog').close() }),
        el('button', {
          class: 'primary',
          type: 'button',
          text: `Link ${proxy.identity}`,
          onclick: async (event) => {
            try {
              await api('/me/logins', { method: 'POST', body: {} });
              event.target.closest('dialog').close();
            } catch (err) {
              showError(problem, err);
            }
          },
        }),
      ),
    );
  }

  /** After your first task: offer to tell you when agents finish or need you, once. */
  function offerNotifications() {
    const asked = 'orco.notifyOffered';
    const n = ctx.notify;
    if (!n || !n.supported() || n.enabled()) return;
    try {
      if (localStorage.getItem(asked)) return;
      localStorage.setItem(asked, '1');
    } catch {
      return;
    }
    modal(
      'Get told when it is done?',
      el('p', { class: 'small', text: 'Agents can take a while. Orco can notify you when one finishes, asks you something, or needs your approval, even when this tab is in the background.' }),
      el(
        'div',
        { class: 'row-end' },
        el('button', { class: 'ghost', type: 'button', text: 'Not now', onclick: (event) => event.target.closest('dialog').close() }),
        el('button', {
          class: 'primary',
          type: 'button',
          text: 'Turn on notifications',
          onclick: async (event) => {
            event.target.closest('dialog').close();
            await n.toggle();
          },
        }),
      ),
    );
  }

  /* Agents */

  /** Ways to connect an agent, each ready to paste. */
  function connectSteps(name, token, join) {
    const tabs = [
      [
        'Your computer (easiest)',
        [
          el('p', { class: 'small', text: 'On the computer where the agent should work, in the folder of your code, run:' }),
          join,
          el('p', {
            class: 'small muted',
            text: 'It finds Claude Code, Codex and other tools there and shows a code; approve it here and pick this agent. Orco then starts the agent whenever it gets a task. To keep it running after a restart, add --service (it says how to install Orco for that).',
          }),
        ],
      ],
      [
        'Claude Code',
        [
          el('p', { class: 'small', text: 'To use Orco from your own Claude Code sessions:' }),
          copyBlock(`claude mcp add --transport http orco ${origin}/mcp --header "Authorization: Bearer ${token ?? '<token>'}"`),
          el('p', { class: 'small muted', text: 'Or install the Orco plugin in Claude Code: /plugin marketplace add CJVigil/Orco, then /plugin install orco@orco, and give it this address and token.' }),
        ],
      ],
      [
        'Codex',
        [
          el('p', { class: 'small', text: 'Add to ~/.codex/config.toml:' }),
          copyBlock(`[mcp_servers.orco]\nurl = "${origin}/mcp"\nbearer_token_env_var = "ORCO_TOKEN"`),
          el('p', { class: 'small', text: 'and set the token where Codex runs:' }),
          copyBlock(`export ORCO_TOKEN=${token ?? '<token>'}`),
        ],
      ],
      [
        'Other tools',
        [
          el('p', { class: 'small', text: 'Any tool that speaks MCP over HTTP: point it at this address with the token as a bearer token.' }),
          copyBlock(JSON.stringify({ mcpServers: { orco: { type: 'http', url: `${origin}/mcp`, headers: { Authorization: `Bearer ${token ?? '<token>'}` } } } }, null, 2)),
          el('p', { class: 'small', text: 'Or from a shell: orco login with the token, then orco watch, orco task …' }),
        ],
      ],
    ];
    const body = el('div', { class: 'guide-tab' });
    const buttons = tabs.map(([label, content], i) =>
      el('button', {
        class: `ghost small${i === 0 ? ' active' : ''}`,
        type: 'button',
        text: label,
        onclick: (event) => {
          for (const b of buttons) b.classList.remove('active');
          event.target.classList.add('active');
          body.replaceChildren(...content.flat());
        },
      }),
    );
    body.replaceChildren(...tabs[0][1].flat());
    return [el('div', { class: 'guide-tabs', role: 'tablist' }, buttons), body];
  }

  /** Make an agent, then show how to connect it. */
  function addAgent() {
    const name = el('input', { required: true, value: `${me().name}-claude`, pattern: '[a-z0-9][a-z0-9\\-]{0,31}', 'aria-label': 'Agent name' });
    const problem = error();
    const dialog = modal(
      'Add an agent',
      el('p', { class: 'small muted', text: 'An agent is an AI helper you own, like Claude Code or Codex. Name it after you and the tool, so people know whose it is.' }),
      el(
        'form',
        {
          class: 'guide-form',
          onsubmit: async (event) => {
            event.preventDefault();
            try {
              const made = await api('/agents', { method: 'POST', body: { name: name.value.trim() } });
              dialog.close();
              showConnect(made.name, made.token);
              void loadStructure();
              if (panel() === 'agents') void showMyAgents();
              ctx.onChange?.();
            } catch (err) {
              showError(problem, err);
            }
          },
        },
        el('label', { text: 'Name' }),
        name,
        problem,
        el('div', { class: 'row-end' }, el('button', { class: 'primary', type: 'submit', text: 'Add agent' })),
      ),
    );
    name.select();
  }

  /** How to connect an agent; with its new token when one was just made. */
  async function showConnect(name, token) {
    const join = await joinBlock();
    modal(
      `Connect ${name}`,
      token
        ? [
            el('p', { class: 'small', text: `${name} is ready. Its token is shown only now; the easiest way below does not need it.` }),
            copyBlock(token, 'Copy token'),
          ]
        : el('p', { class: 'small muted', text: 'The easiest way needs no token. The others need one: make a new one under My agents (the old one stops working).' }),
      connectSteps(name, token, join),
    );
  }

  /** Ask for a code shown by orco connect, then approve it. */
  async function connectComputer() {
    const join = await joinBlock();
    const code = el('input', { required: true, placeholder: 'ABCD-EFGH', autocomplete: 'off', 'aria-label': 'Code', class: 'code-input' });
    const problem = error();
    const dialog = modal(
      'Connect a computer',
      el('p', { class: 'small', text: 'On the computer where your agents should work, in the folder of your code, run:' }),
      join,
      el('p', { class: 'small muted', text: 'It shows a code. Type it here from that computer’s screen; never enter a code someone sent you.' }),
      el(
        'form',
        {
          class: 'guide-form',
          onsubmit: async (event) => {
            event.preventDefault();
            try {
              const view = await api(`/pair/code/${encodeURIComponent(code.value.trim())}`);
              dialog.close();
              approveComputer(view);
            } catch (err) {
              showError(problem, err);
            }
          },
        },
        el('label', { text: 'Code' }),
        code,
        problem,
        el('div', { class: 'row-end' }, el('button', { class: 'primary', type: 'submit', text: 'Next' })),
      ),
    );
    code.focus();
  }


  /** Pick which agents run on a computer that asked to join. */
  async function approveComputer(view) {
    const mine = (await api('/agents')).map((a) => a.name);
    const tools = view.tools.length ? view.tools : ['claude'];
    const rows = tools.map((tool, i) => {
      const use = el('input', { type: 'checkbox', checked: i === 0 || view.tools.length > 0 ? true : null });
      // Reusing an agent ends its current token, so only suggest one for a request from your own network.
      const existing = view.sameNetwork ? mine.find((n) => n.endsWith(`-${tool}`)) : undefined;
      let suggested = existing ?? `${me().name}-${tool}`;
      for (let n = 2; !existing && mine.includes(suggested); n++) suggested = `${me().name}-${tool}-${n}`;
      const name = el('input', { value: suggested, pattern: '[a-z0-9][a-z0-9\\-]{0,31}', 'aria-label': `Agent for ${TOOL_NAMES[tool] ?? tool}` });
      const note = el('span', { class: 'muted small' });
      const explain = () => {
        const reuse = mine.includes(name.value.trim());
        note.textContent = reuse ? 'your existing agent: approving ends its current token, so wherever it runs now stops until you reconnect it' : 'a new agent';
        note.classList.toggle('warn-text', reuse);
      };
      name.addEventListener('input', explain);
      explain();
      const preset = view.tools.length
        ? el('strong', { text: TOOL_NAMES[tool] ?? tool })
        : el('select', {}, Object.entries(TOOL_NAMES).map(([key, label]) => el('option', { value: key, text: label })));
      return { use, name, tool, preset, node: el('div', { class: 'pair-row' }, use, preset, name, note) };
    });
    const problem = error();
    const dialog = modal(
      'Connect a computer',
      el('p', { class: 'small' }, 'A computer calling itself ', el('strong', { text: view.host }), ` wants to run your agents${view.cwd ? ` in ${view.cwd}` : ''}.`),
      el('p', { class: 'small muted', text: `The request came from ${view.from}${view.sameNetwork ? ', the same network as you.' : '.'}` }),
      view.sameNetwork
        ? null
        : el('p', {
            class: 'small warn-text',
            role: 'alert',
            text: 'That is not the network you are on. If you did not just run the connect command on that computer yourself, decline: someone may be trying to get a token for your agents.',
          }),
      el('p', {
        class: 'small muted',
        text: view.tools.length
          ? 'It has these tools. Choose which become your agents there:'
          : 'It found no agent tools yet. Pick the one you will install:',
      }),
      rows.map((r) => r.node),
      el('p', { class: 'small muted', text: 'Only approve a code you started yourself. The computer gets tokens for these agents, and they act as you allow your agents to.' }),
      problem,
      el(
        'div',
        { class: 'row-end' },
        el('button', {
          class: 'ghost',
          type: 'button',
          text: 'Decline',
          onclick: async () => {
            await api(`/pair/code/${encodeURIComponent(view.code)}`, { method: 'POST', body: { decision: 'deny' } }).catch(() => {});
            dialog.close();
          },
        }),
        el('button', {
          class: 'primary',
          type: 'button',
          text: 'Approve',
          onclick: async () => {
            const agents = rows.filter((r) => r.use.checked).map((r) => ({ agent: r.name.value.trim(), preset: r.preset.value ?? r.tool }));
            try {
              const done = await api(`/pair/code/${encodeURIComponent(view.code)}`, { method: 'POST', body: { agents } });
              dialog.close();
              modal(
                'Connected',
                el('p', { text: `${view.host} now runs ${done.agents.map((a) => a.name).join(', ')}.` }),
                el('p', { class: 'small muted', text: 'It is finishing setup and will start the bridge. Next: ask one of them to do something.' }),
                el('div', { class: 'row-end' }, el('button', { class: 'primary', type: 'button', text: 'Ask an agent', onclick: (event) => (event.target.closest('dialog').close(), askAgent()) })),
              );
              void loadStructure();
              if (panel() === 'agents') void showMyAgents();
              ctx.onChange?.();
            } catch (err) {
              showError(problem, err);
            }
          },
        }),
      ),
    );
    return dialog;
  }

  /* Asking an agent */

  /** A form for giving an agent a task, instead of typing /task. */
  async function askAgent(prefill, preferred) {
    const here = room();
    const where = here?.ref;
    if (!where) return;
    const people = await api(`/participants${here.project ? `?project=${encodeURIComponent(here.project)}` : ''}`);
    const agents = people.filter((p) => p.kind === 'agent');
    if (!agents.length) {
      modal(
        'No agents here yet',
        el('p', { class: 'small', text: here.project ? `No agent can see ${here.project}. Add one (it sees the projects you are in), or add its owner to the project.` : 'Add an agent first.' }),
        el('div', { class: 'row-end' }, el('button', { class: 'primary', type: 'button', text: 'Add an agent', onclick: (event) => (event.target.closest('dialog').close(), addAgent()) })),
      );
      return;
    }
    const status = { listening: 'ready', online: 'online', standby: 'asleep, wakes for tasks', offline: 'offline: it starts when its computer is connected' };
    const agent = el(
      'select',
      { 'aria-label': 'Agent' },
      agents
        .sort((a, b) => Number(b.owner === me().name) - Number(a.owner === me().name))
        .map((a) => el('option', { value: a.name, selected: a.name === preferred, text: `${a.name} · ${status[a.status] ?? a.status}${a.owner === me().name ? '' : ` · ${a.owner}'s`}` })),
    );
    const request = el('textarea', { rows: '5', required: true, placeholder: 'What should it do? Say what “done” looks like.', text: prefill ?? '' });
    const minutes = el('input', { inputmode: 'numeric', placeholder: 'minutes', 'aria-label': 'Time limit in minutes' });
    const dollars = el('input', { inputmode: 'decimal', placeholder: '$', 'aria-label': 'Cost limit in dollars' });
    const problem = error();
    const dialog = modal(
      `Ask an agent in #${here.name}`,
      el('label', { text: 'Agent' }),
      agent,
      el('label', { text: 'What to do' }),
      el(
        'div',
        { class: 'templates' },
        TEMPLATES.map(([label, text]) =>
          el('button', {
            class: 'ghost small',
            type: 'button',
            text: label,
            onclick: () => {
              request.value = text;
              request.focus();
              const start = text.indexOf('<');
              if (start >= 0) request.setSelectionRange(start, text.indexOf('>', start) + 1);
            },
          }),
        ),
      ),
      request,
      el(
        'details',
        { class: 'small' },
        el('summary', { text: 'Limits (optional)' }),
        el('p', { class: 'muted small', text: 'The agent is asked to stop and check with you if it goes past these.' }),
        el('div', { class: 'pf-row' }, minutes, dollars),
      ),
      el('p', { class: 'small muted', text: 'It shows up as a task in the room. You will see it accept, its progress, any questions, and the result.' }),
      problem,
      el(
        'div',
        { class: 'row-end' },
        el('button', {
          class: 'primary',
          type: 'button',
          text: 'Ask',
          onclick: async () => {
            const text = request.value.trim();
            if (!text) return showError(problem, new Error('Say what it should do'));
            if (/<[^>]+>/.test(text)) return showError(problem, new Error('Fill in the parts in <angle brackets> first'));
            const body = { agent: agent.value, room: where, request: text };
            if (minutes.value.trim()) body.budget_minutes = Number(minutes.value.trim());
            if (dollars.value.trim()) body.budget_cents = Math.round(Number(dollars.value.replace(/[$,\s]/g, '')) * 100);
            try {
              await api('/tasks', { method: 'POST', body });
              dialog.close();
              ctx.onChange?.();
              offerNotifications();
            } catch (err) {
              showError(problem, err);
            }
          },
        }),
      ),
    );
    request.focus();
  }

  /* Getting started */

  const DISMISSED = 'orco.gettingStartedDismissed';
  const dismissed = () => {
    try {
      return localStorage.getItem(DISMISSED) === '1';
    } catch {
      return false;
    }
  };

  /** Updates the sidebar button: how many first steps are done, hidden once all are or it is dismissed. */
  async function refreshSteps() {
    const button = $('getting-started');
    if (!button || me()?.kind !== 'user') return;
    let steps;
    try {
      steps = await api('/getting-started');
    } catch {
      return;
    }
    const done = steps.filter((s) => s.done).length;
    button.hidden = dismissed() || done === steps.length;
    button.querySelector('.label').textContent = `Getting started · ${done} of ${steps.length}`;
    if (panel() === 'start') renderSteps(steps);
  }

  async function showSteps() {
    openPanel('start', 'Getting started');
    renderSteps(await api('/getting-started'));
  }

  function renderSteps(steps) {
    const actions = { project: () => void newProject(), agent: addAgent, connect: connectComputer, task: () => void askAgent() };
    const next = steps.find((s) => !s.done);
    const nodes = [
      el('p', { class: 'panel-intro muted small', text: 'Orco is a team chat where people and AI agents work together. Five steps to your first result:' }),
      el(
        'ol',
        { class: 'steps' },
        steps.map((s) =>
          el(
            'li',
            { class: `step${s.done ? ' done' : ''}${s === next ? ' next' : ''}` },
            el('span', { class: 'step-mark', 'aria-hidden': 'true', text: s.done ? '✓' : '' }),
            el('span', { class: 'step-title', text: s.title }),
            !s.done && STEP_ACTIONS[s.key] ? el('button', { class: s === next ? 'primary small' : 'ghost small', type: 'button', text: STEP_ACTIONS[s.key], onclick: actions[s.key] }) : null,
          ),
        ),
      ),
      next?.key === 'result'
        ? el('p', { class: 'panel-intro small', text: 'Your agent is on it. Watch its task in the room: it accepts, reports progress, may ask you something, and posts the result. Rate the result with ▲ or ▼.' })
        : null,
      el('p', { class: 'panel-intro small' }, el('a', { href: '#!help', text: 'How Orco works' }), ' · ', el('button', {
        class: 'link small',
        type: 'button',
        text: 'Hide this',
        onclick: () => {
          try {
            localStorage.setItem(DISMISSED, '1');
          } catch {
            // Private mode: it shows again next time.
          }
          $('getting-started').hidden = true;
          ctx.closePanel();
        },
      })),
    ];
    $('panel-body').replaceChildren(...nodes.filter(Boolean));
  }

  /* Help */

  function showHelp() {
    openPanel('help', 'How Orco works');
    $('panel-body').replaceChildren(
      el('p', { class: 'panel-intro small', text: 'Orco is a group chat for people and their AI agents. You talk in rooms, hand agents tasks, and they report back in the same place, asking you before anything risky.' }),
      el(
        'dl',
        { class: 'glossary' },
        GLOSSARY.flatMap(([term, text]) => [el('dt', { text: term }), el('dd', { class: 'small', text })]),
      ),
      el('p', { class: 'panel-intro small muted', text: 'Tip: in any room, type /task @agent and what to do, or use the Ask an agent button.' }),
    );
  }

  return { offerLinkLogin, stepsDismissed: dismissed, signInLink, showOtherDevice, showWelcome, copyBlock, showSetup, addAgent, showConnect, connectComputer, askAgent, refreshSteps, showSteps, showHelp };
}
