// "Needs you": the few things waiting on the signed-in person, three at a time, each with its one
// action inline, so the first screen after signing in says what to do next. Everything else (agents'
// open tasks, plain mentions, suggestions) sits under one folded FYI line. DOM built with el() only.

const SHOW = 3;

export function createNeeds(ctx) {
  const { api, el, $, answerBox, decideApproval, jumpTo, openTicket } = ctx;
  const root = $('needs-view');
  const n = { all: false, timer: null, loading: null };

  /** The things waiting on this person, most urgent first, each with what to show and its action. */
  function items(inbox) {
    const out = [];
    for (const a of inbox.approvals) {
      out.push({
        key: `approval-${a.id}`,
        kind: 'Approve',
        title: a.summary,
        detail: `${a.requester} in #${a.room}${a.scope ? ` · scope: ${a.scope.split('\n')[0]}` : ''}`,
        actions: () => [
          el('button', { class: 'primary small', type: 'button', text: 'Approve', onclick: () => void act(() => decideApproval(a.id, 'approved')) }),
          el('button', { class: 'ghost small danger', type: 'button', text: 'Deny', onclick: () => void act(() => decideApproval(a.id, 'denied')) }),
          el('button', { class: 'ghost small', type: 'button', text: 'Open', onclick: () => void jumpTo({ id: a.messageId, room: a.room, threadId: null }) }),
        ],
      });
    }
    for (const q of inbox.questions) {
      out.push({
        key: `question-${q.id}`,
        kind: q.kind === 'plan' ? 'Review plan' : 'Answer',
        title: q.kind === 'plan' ? `${q.asker} proposed a plan for task #${q.taskId}` : q.question,
        detail: `${q.asker} · task #${q.taskId} · ${q.room}`,
        actions: () =>
          q.kind === 'plan'
            ? [el('button', { class: 'primary small', type: 'button', text: 'Open plan', onclick: () => void jumpTo({ id: q.messageId, room: q.room, threadId: q.threadId }) })]
            : [answerBox(q, () => void reload())],
      });
    }
    for (const t of inbox.waiting ?? []) {
      const reply = el('input', { class: 'answer-input', placeholder: 'Or reply in a line', 'aria-label': `Reply on ${t.ref}`, maxlength: '140' });
      const send = (text) => act(() => api(`/tickets/${t.ref}/waiting`, { method: 'POST', body: { reply: text } }));
      reply.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' && reply.value.trim()) {
          event.preventDefault();
          void send(reply.value.trim());
        }
      });
      out.push({
        key: `waiting-${t.ref}`,
        kind: 'Do',
        title: t.waitingOn.ask,
        detail: `${t.ref} · ${t.title}${t.assignee ? ` · for ${t.assignee.name}` : ''}`,
        actions: () => [
          el('button', { class: 'primary small', type: 'button', text: 'Done', onclick: () => void send('done') }),
          el('button', { class: 'ghost small', type: 'button', text: 'Not yet', title: 'Ask me again tomorrow', onclick: () => void send('not_yet') }),
          reply,
          el('button', { class: 'ghost small', type: 'button', text: 'Open', onclick: () => void openTicket(t.ref) }),
        ],
      });
    }
    for (const r of inbox.reviews) {
      out.push({
        key: `review-${r.id}`,
        kind: 'Review',
        title: `${r.requester} asks you to review ${r.target}`,
        detail: r.summary ?? '',
        actions: () => [
          el('button', {
            class: 'primary small',
            type: 'button',
            text: 'Review',
            onclick: () => void (r.ticket ? openTicket(r.ticket) : jumpTo({ id: r.messageId, room: r.room, threadId: null })),
          }),
        ],
      });
    }
    for (const f of inbox.flags ?? []) {
      out.push({
        key: `flag-${f.id}`,
        kind: 'Check',
        title: `${f.flagger} flagged ${f.ticket ? f.ticket.ref : 'a message'}`,
        detail: f.reason ?? '',
        actions: () => [
          f.message
            ? el('button', { class: 'primary small', type: 'button', text: 'Open', onclick: () => void jumpTo({ id: f.message.id, room: f.message.room, threadId: f.message.threadId }) })
            : f.ticket
              ? el('button', { class: 'primary small', type: 'button', text: 'Open', onclick: () => void openTicket(f.ticket.ref) })
              : null,
        ],
      });
    }
    for (const t of inbox.stalled ?? []) {
      out.push({
        key: `stalled-${t.id}`,
        kind: 'Check',
        title: `${t.assignee} has gone quiet on task #${t.id}`,
        detail: t.request,
        actions: () => [el('button', { class: 'primary small', type: 'button', text: 'Open', onclick: () => void jumpTo({ id: t.messageId, room: t.room, threadId: null }) })],
      });
    }
    for (const t of (inbox.tickets ?? []).filter((x) => !x.blocked && !(inbox.waiting ?? []).some((w) => w.ref === x.ref))) {
      out.push({
        key: `ticket-${t.ref}`,
        kind: 'Work on',
        title: `${t.ref} ${t.title}`,
        detail: t.nextStep ? `Next: ${t.nextStep.text}` : 'No next step',
        actions: () => [el('button', { class: 'primary small', type: 'button', text: 'Open', onclick: () => void openTicket(t.ref) })],
      });
    }
    return out;
  }

  function fyi(inbox) {
    const tasks = inbox.tasks ?? [];
    const mentions = (inbox.mentions ?? []).filter((m) => !m.seen);
    const suggestions = inbox.suggestions ?? [];
    const count = tasks.length + mentions.length + suggestions.length;
    if (!count) return null;
    return el(
      'details',
      { class: 'needs-fyi' },
      el('summary', { class: 'small', text: `FYI: ${[tasks.length ? `${tasks.length} open agent task${tasks.length === 1 ? '' : 's'}` : null, mentions.length ? `${mentions.length} mention${mentions.length === 1 ? '' : 's'}` : null, suggestions.length ? `${suggestions.length} suggestion${suggestions.length === 1 ? '' : 's'}` : null].filter(Boolean).join(' · ')}` }),
      el(
        'ul',
        { class: 'small' },
        tasks.map((t) => el('li', {}, el('button', { class: 'link-button', type: 'button', text: `Task #${t.id} · ${t.assignee} · ${t.state}: ${t.request.split('\n')[0]}`, onclick: () => void jumpTo({ id: t.messageId, room: t.room, threadId: null }) }))),
        mentions.map((m) => el('li', {}, el('button', { class: 'link-button', type: 'button', text: `${m.author} in #${m.room}: ${m.text.split('\n')[0]}`, onclick: () => void jumpTo({ id: m.id, room: m.room, threadId: m.threadId }) }))),
        suggestions.map((s) => el('li', { text: `Suggested: ${s.title}` })),
      ),
    );
  }

  function render(inbox) {
    const list = items(inbox);
    const shown = n.all ? list : list.slice(0, SHOW);
    root.replaceChildren(
      el(
        'div',
        { class: 'needs' },
        el('h2', { class: 'needs-title', text: list.length ? 'Needs you' : 'Nothing needs you' }),
        list.length ? null : el('p', { class: 'muted', text: 'Approvals, questions and asks for you show up here, three at a time.' }),
        shown.map((item) =>
          el(
            'article',
            { class: 'needs-item', 'data-key': item.key },
            el('div', { class: 'needs-kind', text: item.kind }),
            el('div', { class: 'needs-main' }, el('strong', { class: 'needs-line', text: item.title }), item.detail ? el('div', { class: 'needs-detail muted small', text: item.detail }) : null),
            el('div', { class: 'needs-actions' }, item.actions()),
          ),
        ),
        list.length > SHOW && !n.all ? el('button', { class: 'ghost small', type: 'button', text: `${list.length - SHOW} more`, onclick: () => ((n.all = true), render(inbox)) }) : null,
        fyi(inbox),
      ),
    );
  }

  async function reload() {
    if (n.loading) return n.loading;
    n.loading = api('/inbox')
      .then((inbox) => {
        if (!root.hidden) render(inbox);
        return inbox;
      })
      .finally(() => (n.loading = null));
    return n.loading;
  }

  async function act(fn) {
    try {
      await fn();
    } catch (err) {
      alert(err.message);
    }
    await reload();
  }

  return {
    show: async () => {
      n.all = false;
      await reload();
    },
    /** Something changed (an approval, a question, a ticket): bring in the next item without a reload. */
    onEvent: () => {
      if (root.hidden) return;
      clearTimeout(n.timer);
      n.timer = setTimeout(() => void reload(), 300);
    },
  };
}
