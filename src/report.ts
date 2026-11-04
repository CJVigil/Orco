import { nextRun, parseCron } from './cron.js';
import { OrcoError } from './errors.js';
import type { Participant, Store } from './store.js';

/*
 * "What got done" (#116): a day or a week in a project (or one of its folders, or one person and
 * their agents), for a manager. Real events only: tickets created, status changes, comments and
 * approvals. Housekeeping (a folder sort, a relabel, a priority shuffle) is left out, so a sort that
 * touches 98 tickets does not make them look worked on. Read as JSON, Markdown, or a one-page print
 * layout; scheduled into a room through the digest tick.
 */

const HOUSEKEEPING = new Set(['folder', 'labels', 'sort', 'priority', 'milestone', 'cycle', 'estimate', 'dueDate', 'private', 'project']);

export interface ReportTicket {
  ref: string;
  title: string;
  status: string;
  assignee: string | null;
  nextStep: string | null;
}

export interface Report {
  project: string;
  folder: string | null;
  person: string | null;
  from: string;
  to: string;
  counts: { done: number; goingLive: number; waiting: number; newRequests: number; events: number };
  done: ReportTicket[];
  goingLive: (ReportTicket & { approval: string })[];
  waiting: (ReportTicket & { on: string; ask: string; since: string })[];
  newRequests: ReportTicket[];
  timeline: { at: string; text: string; ref: string }[];
  openByFolder: { folder: string; open: number }[];
}

export function dayReport(store: Store, actor: Participant, input: { project: string; from: string; to: string; folder?: string | null; person?: string | null }): Report {
  const from = new Date(Date.parse(input.from));
  const to = new Date(Date.parse(input.to));
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || to <= from) throw new OrcoError('invalid', 'from and to are times, to after from');
  if (to.getTime() - from.getTime() > 92 * 86_400_000) throw new OrcoError('invalid', 'A report covers at most 92 days');
  const all = store.tickets.list(actor, { project: input.project, limit: 500 });
  // Open and recently closed tickets: list() is ordered by status, so ask for closed ones too.
  const closed = store.tickets.list(actor, { project: input.project, categories: ['completed', 'canceled'], limit: 500 });
  const byRef = new Map([...all, ...closed].map((t) => [t.ref, t]));
  let person: Participant | null = null;
  if (input.person) {
    person = store.participantByName(input.person.replace(/^@/, ''));
    if (!person || person.kind !== 'user') throw new OrcoError('not_found', `No person named ${input.person}`);
  }
  const theirs = (assignee: { name: string; kind: string } | null) => {
    if (!person) return true;
    if (!assignee) return false;
    if (assignee.name === person.name) return true;
    const p = store.participantByName(assignee.name);
    return p?.ownerId === person.id;
  };
  const inScope = [...byRef.values()].filter((t) => (!input.folder || t.folder?.name.toLowerCase() === input.folder.toLowerCase()) && theirs(t.assignee));
  const ids = new Set(inScope.map((t) => t.id));
  const fromIso = from.toISOString();
  const toIso = to.toISOString();
  const within = (iso: string | null) => iso !== null && iso >= fromIso && iso < toIso;
  const row = (t: (typeof inScope)[number]): ReportTicket => ({ ref: t.ref, title: t.title, status: t.status.name, assignee: t.assignee?.name ?? null, nextStep: t.nextStep?.text ?? null });

  const done = inScope.filter((t) => t.status.category === 'completed' && within(t.completedAt));
  const newRequests = inScope.filter((t) => within(t.createdAt));
  const waiting = inScope.filter((t) => t.waitingOn && t.status.category !== 'completed' && t.status.category !== 'canceled');
  const approvals = store.db
    .prepare(
      `SELECT ap.ticket_id, ap.summary, ap.state, ap.decided_at, d.name AS decided_by FROM approvals ap LEFT JOIN participants d ON d.id = ap.decided_by
       WHERE ap.ticket_id IS NOT NULL AND ap.kind = 'action' ORDER BY ap.id DESC`,
    )
    .all() as { ticket_id: number; summary: string; state: string; decided_at: number | null; decided_by: string | null }[];
  const latestApproval = new Map<number, (typeof approvals)[number]>();
  for (const a of approvals) if (!latestApproval.has(a.ticket_id)) latestApproval.set(a.ticket_id, a);
  const goingLive = inScope
    .filter((t) => t.status.category === 'started' && (/review|ready|deploy|release/i.test(t.status.name) || latestApproval.has(t.id)))
    .map((t) => {
      const a = latestApproval.get(t.id);
      return { ...row(t), approval: a ? `${a.state === 'pending' ? 'waiting for approval' : a.state}${a.decided_by ? ` by ${a.decided_by}` : ''}: ${a.summary}` : 'in review, no approval asked yet' };
    });

  // The timeline: real events only, each once.
  const activity = ids.size
    ? (store.db
        .prepare(
          `SELECT ta.ticket_id, ta.kind, ta.detail, ta.created_at, p.name AS actor FROM ticket_activity ta LEFT JOIN participants p ON p.id = ta.actor_id
           WHERE ta.ticket_id IN (${[...ids].map(() => '?').join(', ')}) AND ta.created_at >= ? AND ta.created_at < ? ORDER BY ta.created_at`,
        )
        .all(...ids, fromIso, toIso) as { ticket_id: number; kind: string; detail: string | null; created_at: string; actor: string | null }[])
    : [];
  const refOfId = new Map(inScope.map((t) => [t.id, t]));
  const timeline: Report['timeline'] = [];
  let events = 0;
  for (const a of activity) {
    const t = refOfId.get(a.ticket_id)!;
    if (a.kind === 'created') {
      events++;
      timeline.push({ at: a.created_at, ref: t.ref, text: `New: ${t.title}${a.actor ? ` (${a.actor})` : ''}` });
    } else if (a.kind === 'comment') {
      events++;
    } else if (a.kind === 'change' && a.detail) {
      const changes = ((JSON.parse(a.detail) as { changes?: { field: string; to: unknown }[] }).changes ?? []).filter((c) => !HOUSEKEEPING.has(c.field));
      if (!changes.length) continue;
      events++;
      const status = changes.find((c) => c.field === 'status');
      if (status) timeline.push({ at: a.created_at, ref: t.ref, text: `${t.title}: ${String(status.to)}${a.actor ? ` (${a.actor})` : ''}` });
    }
  }
  for (const a of approvals) {
    if (!ids.has(a.ticket_id) || a.decided_at === null) continue;
    const at = new Date(a.decided_at).toISOString();
    if (!within(at)) continue;
    events++;
    timeline.push({ at, ref: refOfId.get(a.ticket_id)!.ref, text: `Approval ${a.state}${a.decided_by ? ` by ${a.decided_by}` : ''}: ${a.summary}` });
  }
  timeline.sort((x, y) => x.at.localeCompare(y.at));

  const folders = new Map<string, number>();
  for (const t of inScope) {
    if (t.status.category === 'completed' || t.status.category === 'canceled') continue;
    const name = t.folder?.name ?? 'No folder';
    folders.set(name, (folders.get(name) ?? 0) + 1);
  }
  return {
    project: input.project,
    folder: input.folder ?? null,
    person: person?.name ?? null,
    from: fromIso,
    to: toIso,
    counts: { done: done.length, goingLive: goingLive.length, waiting: waiting.length, newRequests: newRequests.length, events },
    done: done.map(row),
    goingLive,
    waiting: waiting.map((t) => ({ ...row(t), on: t.waitingOn!.person, ask: t.waitingOn!.ask, since: t.waitingOn!.since })),
    newRequests: newRequests.map(row),
    timeline: timeline.slice(0, 60),
    openByFolder: [...folders.entries()].map(([folder, open]) => ({ folder, open })).sort((a, b) => b.open - a.open),
  };
}

/** The report as Markdown: plain language first, ticket keys in brackets. */
export function reportMarkdown(r: Report): string {
  const scope = [r.project, r.folder, r.person ? `${r.person} and their agents` : null].filter(Boolean).join(' · ');
  const day = (iso: string) => iso.slice(0, 16).replace('T', ' ');
  const list = (items: string[]) => (items.length ? items : ['- Nothing.']);
  return [
    `**What got done · ${scope} · ${day(r.from)} to ${day(r.to)} UTC**`,
    '',
    `Done ${r.counts.done} · Going live next ${r.counts.goingLive} · Waiting on a person ${r.counts.waiting} · New requests ${r.counts.newRequests}`,
    '',
    '**Done**',
    ...list(r.done.map((t) => `- ${t.title} [${t.ref}]`)),
    '',
    '**Going live next**',
    ...list(r.goingLive.map((t) => `- ${t.title}: ${t.approval} [${t.ref}]`)),
    '',
    '**Waiting on whom**',
    ...list(r.waiting.map((t) => `- ${t.on}: ${t.ask} (${t.title}) [${t.ref}]`)),
    '',
    '**New requests**',
    ...list(r.newRequests.map((t) => `- ${t.title}${t.nextStep ? `: next, ${t.nextStep}` : ''} [${t.ref}]`)),
    '',
    '**Timeline**',
    ...list(r.timeline.map((e) => `- ${day(e.at)} ${e.text}`)),
  ].join('\n');
}

/** Project admins schedule the report into the project's #general, naming the people it is for. */
export function scheduleReport(store: Store, actor: Participant, project: string, input: { cron: string; tz?: string; days?: number; people?: string[] }): { id: number } {
  if (actor.kind !== 'user') throw new OrcoError('forbidden', 'Only people schedule reports');
  const p = store.visibleProject(actor, project);
  if (store.roleIn(actor, p.id) !== 'admin' && !store.isOrgAdmin(actor)) throw new OrcoError('forbidden', `Only admins of ${project} schedule its reports`);
  parseCron(input.cron);
  const days = Math.min(Math.max(input.days ?? 7, 1), 31);
  const people = (input.people ?? []).map((n) => n.replace(/^@/, '').trim()).filter(Boolean);
  for (const name of people) {
    const person = store.participantByName(name);
    if (!person || !store.canSee(person, p.id)) throw new OrcoError('invalid', `${name} is not in ${project}`);
  }
  const { lastInsertRowid } = store.db
    .prepare('INSERT INTO report_schedules (project_id, cron, tz, days, people, created_by, last_run) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(p.id, input.cron, input.tz ?? 'UTC', days, people.join(','), actor.id, store.now());
  store.audit.record(actor, 'report.schedule', { projectId: p.id, subject: `project:${project}`, detail: { cron: input.cron, days, people } });
  return { id: Number(lastInsertRowid) };
}

/** Posts the reports whose time has come (called once a minute). */
export function runReports(store: Store): number {
  const due = store.db.prepare('SELECT s.*, p.name AS project FROM report_schedules s JOIN projects p ON p.id = s.project_id').all() as {
    id: number; project: string; cron: string; tz: string; days: number; people: string; created_by: number; last_run: number | null;
  }[];
  let posted = 0;
  const now = store.now();
  for (const s of due) {
    const next = nextRun(parseCron(s.cron), s.last_run ?? now - 60_000, s.tz);
    if (next > now) continue;
    store.db.prepare('UPDATE report_schedules SET last_run = ? WHERE id = ?').run(now, s.id);
    const author = store.participantById(s.created_by);
    const system = store.system();
    if (!author || !system) continue;
    try {
      const report = dayReport(store, author, { project: s.project, from: new Date(now - s.days * 86_400_000).toISOString(), to: new Date(now).toISOString() });
      const mention = s.people ? `${s.people.split(',').map((n) => `@${n}`).join(' ')}\n` : '';
      store.post(system, `${s.project}/general`, `${mention}${reportMarkdown(report)}`, undefined, { skipRateLimit: true });
      posted++;
    } catch {
      // The author lost access, or the project has no #general: skip this time.
    }
  }
  return posted;
}
