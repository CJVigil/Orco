// The command palette (#93): Ctrl+K (⌘K on a Mac) anywhere to jump to a room, a ticket (by its key or
// words in it), a place or a person, and to act on the open ticket without the mouse: assign it, move
// it, set its next step, ask someone. Tab on a ticket gives its actions. DOM built with el() only.

const LIMIT = 12;

/** Case-insensitive match on any of the words, best first: an exact or leading match beats one inside. */
function score(text, query) {
  const t = text.toLowerCase();
  const q = query.trim().toLowerCase();
  if (!q) return 1;
  if (t === q) return 4;
  if (t.startsWith(q)) return 3;
  if (t.split(/[\s/#@·-]+/).some((w) => w.startsWith(q))) return 2;
  return t.includes(q) ? 1 : 0;
}

export function createPalette(ctx) {
  const { el, api } = ctx;
  let root = null;
  let input = null;
  let list = null;
  let hint = null;
  let mode = null;
  let items = [];
  let active = 0;
  let seq = 0;
  let timer = null;
  let people = null;

  const HINTS = {
    search: '↑↓ move · Enter open · Tab ticket actions · Esc close',
    pick: '↑↓ move · Enter choose · Esc back',
    text: 'Enter save · Esc back',
  };

  function open(start) {
    if (!root) {
      input = el('input', { class: 'palette-input', type: 'text', autocomplete: 'off', spellcheck: 'false', 'aria-label': 'Jump to or do', 'aria-controls': 'palette-list', 'aria-autocomplete': 'list' });
      list = el('ul', { id: 'palette-list', class: 'palette-list', role: 'listbox', 'aria-label': 'Results' });
      hint = el('div', { class: 'palette-hint small muted' });
      root = el(
        'div',
        {
          class: 'palette-backdrop',
          onmousedown: (event) => {
            if (event.target === root) close();
          },
        },
        el('div', { class: 'palette', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Command palette' }, input, list, hint),
      );
      document.body.append(root);
      input.addEventListener('input', () => schedule());
      input.addEventListener('keydown', onKey);
      people = null;
    }
    setMode(start ?? { kind: 'search' });
    input.focus();
  }

  function close() {
    clearTimeout(timer);
    root?.remove();
    root = null;
  }

  const isOpen = () => root !== null;

  function setMode(next) {
    mode = next;
    input.value = next.value ?? '';
    input.placeholder = next.placeholder ?? (next.kind === 'search' ? 'Jump to a room, ticket or person, or act on the open ticket' : next.title);
    hint.textContent = HINTS[next.kind];
    void refresh();
  }

  function schedule() {
    clearTimeout(timer);
    // Local matches show at once; the ticket search waits for a short pause in typing.
    void refresh({ local: true });
    timer = setTimeout(() => void refresh(), 70);
  }

  /** The actions for one ticket: open it, assign, status, next step, ask someone, folder. */
  async function ticketActions(ticket) {
    const plan = await ctx.planFor(ticket.project);
    const write = async (body, done) => {
      try {
        await api(`/tickets/${encodeURIComponent(ticket.ref)}`, { method: 'POST', body });
        ctx.notify(`${ticket.ref}: ${done}`);
        ctx.afterTicket(ticket.ref);
      } catch (err) {
        ctx.notify(err.message);
      }
      close();
    };
    const members = plan.members ?? [];
    const peopleOnly = members.filter((m) => m.kind === 'user');
    return [
      { label: `Open ${ticket.ref}`, hint: ticket.title ?? '', run: () => (close(), ctx.openTicket(ticket.ref)) },
      {
        label: `Assign ${ticket.ref}…`,
        hint: 'to a person or agent',
        run: () =>
          setMode({
            kind: 'pick',
            title: `Assign ${ticket.ref} to…`,
            items: [
              { label: 'Nobody', hint: 'unassign', run: () => write({ assignee: null }, 'unassigned') },
              ...members.map((m) => ({ label: `@${m.name}`, hint: m.kind === 'agent' ? `agent · ${m.owner ?? ''}` : 'person', run: () => write({ assignee: m.name }, `assigned to ${m.name}`) })),
            ],
          }),
      },
      {
        label: `Move ${ticket.ref} to…`,
        hint: 'a status',
        run: () =>
          setMode({ kind: 'pick', title: `Move ${ticket.ref} to…`, items: plan.statuses.map((s) => ({ label: s.name, hint: s.category, run: () => write({ status: s.name }, `moved to ${s.name}`) })) }),
      },
      {
        label: `Set the next step of ${ticket.ref}…`,
        hint: 'one line',
        run: () => setMode({ kind: 'text', title: `The next step for ${ticket.ref}`, run: (text) => write({ nextStep: text }, `next: ${text}`) }),
      },
      {
        label: `Ask someone on ${ticket.ref}…`,
        hint: 'waiting on a person',
        run: () =>
          setMode({
            kind: 'pick',
            title: `Who should do something on ${ticket.ref}?`,
            items: peopleOnly.map((p) => ({
              label: `@${p.name}`,
              hint: 'person',
              run: () => setMode({ kind: 'text', title: `What do you need from ${p.name}? (a question gets Yes / No)`, run: (text) => write({ waitingOn: p.name, waitingAsk: text }, `waiting on ${p.name}`) }),
            })),
          }),
      },
      ...(plan.folders?.length
        ? [
            {
              label: `Put ${ticket.ref} in a folder…`,
              hint: 'folder',
              run: () =>
                setMode({
                  kind: 'pick',
                  title: `Folder for ${ticket.ref}`,
                  items: [{ label: 'No folder', hint: '', run: () => write({ folder: null }, 'out of its folder') }, ...plan.folders.map((f) => ({ label: `${f.emoji ? `${f.emoji} ` : ''}${f.name}`, hint: 'folder', run: () => write({ folder: f.name }, `in ${f.name}`) }))],
                }),
            },
          ]
        : []),
    ];
  }

  /** Everything the person can jump to, without the server: actions on the open ticket, places, rooms, people. */
  function localItems(query) {
    const out = [];
    const current = ctx.currentTicket();
    if (current) out.push({ label: `Act on ${current.ref}…`, hint: 'assign, move, next step, ask', group: 'ticket', run: async () => setMode({ kind: 'pick', title: `${current.ref}: do what?`, items: await ticketActions(current) }) });
    for (const place of ctx.places()) out.push({ ...place, group: 'place' });
    for (const room of ctx.rooms()) out.push({ label: `#${room.name}`, hint: room.project ?? 'server', group: 'room', run: () => (close(), ctx.openRoom(room.ref)) });
    for (const project of ctx.projects()) out.push({ label: `Tickets · ${project.name}`, hint: `${project.ticketKey ?? ''} board`, group: 'room', run: () => (close(), ctx.openTickets(project.name)) });
    for (const p of people ?? []) out.push({ label: `@${p.name}`, hint: p.kind === 'agent' ? `mention · agent of ${p.owner}` : 'mention', group: 'person', run: () => (close(), ctx.mention(p.name)) });
    return out
      .map((item) => ({ item, s: Math.max(score(item.label, query), score(item.hint ?? '', query) > 1 ? 1 : 0) }))
      .filter(({ s }) => s > 0)
      .sort((a, b) => b.s - a.s)
      .map(({ item }) => item);
  }

  async function refresh({ local = false } = {}) {
    if (!root) return;
    const query = input.value;
    if (mode.kind === 'text') {
      items = query.trim() ? [{ label: query.trim(), hint: 'Enter to save', run: () => mode.run(query.trim()) }] : [];
      active = 0;
      return render(mode.title);
    }
    if (mode.kind === 'pick') {
      items = mode.items.filter((i) => score(`${i.label} ${i.hint ?? ''}`, query) > 0);
      active = Math.min(active, Math.max(items.length - 1, 0));
      return render(mode.title);
    }
    if (people === null) {
      people = [];
      void ctx.people().then((list_) => {
        people = list_;
        if (root && mode.kind === 'search') void refresh({ local: true });
      });
    }
    const mine = ++seq;
    const near = localItems(query);
    const search = query.trim() ? [{ label: `Search everything for “${query.trim()}”`, hint: 'messages, tickets, notes, tasks', group: 'search', run: () => (close(), ctx.search(query.trim())) }] : [];
    if (local || !query.trim()) {
      items = [...near.slice(0, LIMIT), ...search];
      active = 0;
      render();
      if (local || !query.trim()) return;
    }
    let tickets = [];
    try {
      tickets = await api(`/tickets?q=${encodeURIComponent(query.trim())}&limit=8`);
    } catch {
      tickets = [];
    }
    if (mine !== seq || !root || mode.kind !== 'search') return;
    const ticketItems = tickets.map((t) => ({
      label: `${t.ref} ${t.title}`,
      hint: `${t.status.name}${t.assignee ? ` · ${t.assignee.name}` : ''}`,
      group: 'ticket',
      ticket: { ref: t.ref, project: t.project, title: t.title },
      run: () => (close(), ctx.openTicket(t.ref)),
    }));
    // A ticket key typed in full goes first.
    const exact = ticketItems.filter((i) => i.ticket.ref.toLowerCase() === query.trim().toLowerCase());
    items = [...exact, ...near.slice(0, 4), ...ticketItems.filter((i) => !exact.includes(i)), ...near.slice(4, LIMIT), ...search].slice(0, LIMIT + 2);
    active = 0;
    render();
  }

  function render(title) {
    list.replaceChildren(
      ...(title ? [el('li', { class: 'palette-title small muted', role: 'presentation', text: title })] : []),
      ...items.map((item, i) =>
        el(
          'li',
          {
            id: `palette-${i}`,
            role: 'option',
            class: `palette-item${i === active ? ' active' : ''}`,
            'aria-selected': i === active ? 'true' : 'false',
            onmousedown: (event) => {
              event.preventDefault();
              active = i;
              void pick();
            },
          },
          el('span', { class: 'palette-label', text: item.label }),
          item.ticket ? el('span', { class: 'palette-tab small muted', text: 'Tab ⇥' }) : null,
          el('span', { class: 'palette-hint-text small muted', text: item.hint ?? '' }),
        ),
      ),
      ...(items.length ? [] : [el('li', { class: 'palette-empty small muted', role: 'presentation', text: mode.kind === 'text' ? 'Type, then Enter' : 'Nothing matches' })]),
    );
    if (items.length) {
      input.setAttribute('aria-activedescendant', `palette-${active}`);
      list.querySelector('.palette-item.active')?.scrollIntoView({ block: 'nearest' });
    } else input.removeAttribute('aria-activedescendant');
  }

  async function pick() {
    const item = items[active];
    if (item) await item.run();
  }

  async function onKey(event) {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (!items.length) return;
      active = (active + (event.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length;
      render(mode.kind === 'search' ? undefined : mode.title);
    } else if (event.key === 'Enter') {
      event.preventDefault();
      await pick();
    } else if (event.key === 'Tab') {
      const item = items[active];
      if (item?.ticket) {
        event.preventDefault();
        setMode({ kind: 'pick', title: `${item.ticket.ref}: do what?`, items: await ticketActions(item.ticket) });
      }
    } else if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      if (mode.kind === 'search') close();
      else setMode({ kind: 'search' });
    } else if (event.key === 'Backspace' && !input.value && mode.kind !== 'search') {
      event.preventDefault();
      setMode({ kind: 'search' });
    }
  }

  return { open, close, isOpen };
}
