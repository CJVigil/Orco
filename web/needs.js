// "Needs you": the few things waiting on the signed-in person, three at a time, each with its one
// action inline, so the first screen after signing in says what to do next. Everything else (agents'
// open tasks, plain mentions, suggestions) sits under one folded FYI line. DOM built with el() only.

const SHOW = 3;

export function createNeeds(ctx) {
  // Claude Code treats a yes that comes through a tool as information, not the person's own (#100).
  const AGAIN = 'Approving this in Orco may need approval again in the agent.';
  const { api, el, $, answerBox, jumpTo, openTicket, me, notifyConfigure, numberedChoices, approvalChoices, exactBlock } = ctx;
  const root = $('needs-view');
  const n = { all: false, timer: null, loading: null };

  /** The things waiting on this person, most urgent first, each with what to show and its action. */
  function items(inbox) {
    const out = [];
    // Approvals read like a permission prompt (#95): the question, exactly what it covers, then 1 / 2 / 3.
    for (const a of inbox.approvals) {
      out.push({
        key: `approval-${a.id}`,
        kind: 'Approve',
        title: a.summary,
        detail: `${a.requester} in #${a.room}${a.ticket ? ` · ${a.ticket}` : ''}`,
        body: () => [a.warning ? el('p', { class: 'approval-warning small', text: `⚠ ${a.warning}` }) : null, a.scope ? exactBlock(`Scope:\n${a.scope}`) : null, exactBlock(a.details)],
        choices: () =>
          approvalChoices({ id: a.id, kind: a.kind, requester: a.requester, requesterHuman: a.requesterOwner ?? a.requester, ticket: a.ticket, actionKind: a.actionKind }, () => void reload()),
        note: AGAIN,
        actions: () => [el('button', { class: 'ghost small', type: 'button', text: 'Open', onclick: () => void jumpTo({ id: a.messageId, room: a.room, threadId: null }) })],
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
        kind: (t.waitingOn.options ?? ['Done']).join() === 'Done' ? 'Do' : 'Answer',
        title: t.waitingOn.ask,
        detail: `${t.ref} · ${t.title}${t.assignee ? ` · for ${t.assignee.name}` : ''}`,
        actions: () => {
          // The reply box stays folded until asked for: two clear choices first.
          const replyButton = el('button', {
            class: 'ghost small',
            type: 'button',
            text: 'Reply',
            onclick: () => {
              replyButton.replaceWith(reply);
              reply.focus();
            },
          });
          return [
            el('button', { class: 'ghost small', type: 'button', text: 'Not yet', title: 'Ask me again tomorrow', onclick: () => void send('not_yet') }),
            replyButton,
            el('button', { class: 'ghost small', type: 'button', text: 'Open', onclick: () => void openTicket(t.ref) }),
          ];
        },
        // The ask's own replies, numbered: Yes / No for a question, Done otherwise, or what the agent offered.
        choices: () => (t.waitingOn.options?.length ? t.waitingOn.options : ['Done']).map((option) => ({ label: option, run: () => send(option) })),
        note: AGAIN,
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
    // Open questions are already cards above; count them once.
    const mentions = (inbox.mentions ?? []).filter((m) => !m.seen && m.question?.state !== 'open');
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

  /** Hides an item for an hour, or until tomorrow morning. */
  function snoozeButtons(key) {
    const tomorrow = () => {
      const d = new Date();
      d.setDate(d.getDate() + 1);
      d.setHours(9, 0, 0, 0);
      return d.toISOString();
    };
    const snooze = (until) => act(() => api('/snoozes', { method: 'POST', body: { key, until } }));
    // One quiet "Later" instead of two buttons on every card; it opens into the two choices.
    const wrap = el('span', { class: 'needs-snooze' });
    const choices = () =>
      wrap.replaceChildren(
        el('button', { class: 'ghost small', type: 'button', text: 'In 1 hour', onclick: () => void snooze(new Date(Date.now() + 3600_000).toISOString()) }),
        el('button', { class: 'ghost small', type: 'button', text: 'Tomorrow', title: 'Until 9:00 tomorrow', onclick: () => void snooze(tomorrow()) }),
      );
    wrap.replaceChildren(el('button', { class: 'ghost small needs-later', type: 'button', text: 'Later', title: 'Hide this for now', onclick: () => (choices(), wrap.querySelector('button')?.focus()) }));
    return wrap;
  }

  function digestCard(digest) {
    if (!digest || !digest.bullets.length) return null;
    return el(
      'section',
      { class: 'needs-digest' },
      el('strong', { text: 'Your digest' }),
      el('ul', { class: 'small' }, digest.bullets.map((b) => el('li', { text: b })), digest.more ? el('li', { class: 'muted', text: `+${digest.more} more` }) : null),
      digest.finished ? el('p', { class: 'small muted', text: digest.finished }) : null,
    );
  }

  /**
   * Notification level, quiet hours and the daily digest time, for this person on every device. Shown
   * in the Notifications panel (the bell in the sidebar), so Needs you holds only what to act on.
   */
  function settingsFields(onSaved = () => {}) {
    const s = me()?.attention;
    if (!s) return null;
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
    const save = (patch) =>
      act(async () => {
        const next = await api('/me/settings', { method: 'POST', body: { tz, ...patch } });
        me().attention = next;
        notifyConfigure(next);
        onSaved();
      });
    const time = (value, label, key) => {
      const input = el('input', { type: 'time', value: value ?? '', 'aria-label': label });
      input.addEventListener('change', () => void save({ [key]: input.value || null }));
      return input;
    };
    const quiet = (value, label, other, key, otherKey) => {
      const input = el('input', { type: 'time', value: value ?? '', 'aria-label': label });
      input.addEventListener('change', () => void save({ [key]: input.value || null, [otherKey]: input.value ? other ?? (key === 'quiet_start' ? '08:00' : '22:00') : null }));
      return input;
    };
    const level = el(
      'select',
      { 'aria-label': 'Notifications', onchange: (event) => void save({ notify_level: event.target.value }) },
      [
        ['needs_me', 'Only what needs me (agent updates batched)'],
        ['all', 'All mentions'],
        ['off', 'Off'],
      ].map(([value, text]) => el('option', { value, text, selected: s.notifyLevel === value })),
    );
    return el(
      'div',
      { class: 'needs-settings' },
      el('label', { class: 'small' }, 'Notify me about ', level),
      el(
        'label',
        { class: 'small' },
        'Quiet hours ',
        el('span', { class: 'time-range' }, 'from ', quiet(s.quietStart, 'Quiet from', s.quietEnd, 'quiet_start', 'quiet_end'), ' to ', quiet(s.quietEnd, 'Quiet until', s.quietStart, 'quiet_end', 'quiet_start')),
      ),
      el('label', { class: 'small' }, 'Weekday digest at ', time(s.digestTime, 'Digest time', 'digest_time'), s.digestTime ? el('button', { class: 'link-button small', type: 'button', text: 'Turn off', onclick: () => void save({ digest_time: null }) }) : null),
    );
  }

  function render(inbox) {
    const snoozed = inbox.snoozes ?? {};
    const list = items(inbox).filter((item) => !snoozed[item.key]);
    const shown = n.all ? list : list.slice(0, SHOW);
    root.replaceChildren(
      el(
        'div',
        { class: 'needs' },
        el('h2', { class: 'needs-title', text: list.length ? 'Needs you' : 'Nothing needs you' }),
        digestCard(inbox.digest),
        list.length ? null : el('p', { class: 'muted', text: 'Approvals, questions and asks for you show up here, three at a time.' }),
        shown.map((item) => {
          const article = el('article', { class: 'needs-item', 'data-key': item.key });
          // append() would print a null as the word "null": leave the missing parts out.
          const parts = [
            el('div', { class: 'needs-kind', text: item.kind }),
            el(
              'div',
              { class: 'needs-main' },
              el('strong', { class: 'needs-line', text: item.title }),
              item.detail ? el('div', { class: 'needs-detail muted small', text: item.detail }) : null,
              item.body ? item.body() : null,
            ),
            item.choices ? numberedChoices(article, item.choices()) : null,
            item.note ? el('p', { class: 'approve-again muted small', text: item.note }) : null,
            el('div', { class: 'needs-actions' }, item.actions(), snoozeButtons(item.key)),
          ];
          article.append(...parts.filter(Boolean));
          return article;
        }),
        list.length > SHOW && !n.all ? el('button', { class: 'ghost small', type: 'button', text: `${list.length - SHOW} more`, onclick: () => ((n.all = true), render(inbox)) }) : null,
        fyi(inbox),
        Object.keys(snoozed).length ? el('p', { class: 'small muted', text: `${Object.keys(snoozed).length} snoozed` }) : null,
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
    settings: settingsFields,
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
