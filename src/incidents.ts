import { OrcoError } from './errors.js';
import { missingSections } from './scope.js';
import type { Participant, Store } from './store.js';
import type { Ticket } from './tickets.js';

/*
 * Incident tickets (#114). An incident is a ticket labelled "incident" whose description is the
 * postmortem: timeline (with timezone), impact, root cause, fix, prevention steps and owner. It
 * cannot close as Done until every section has content and each prevention step names a follow-up
 * ticket. Started from a message or alert, it links back to it. The project's other labels on an
 * incident are its tags, so closed incidents can be listed by tag with their root causes.
 */

export const INCIDENT_LABEL = 'incident';
export const INCIDENT_SECTIONS = ['Timeline', 'Impact', 'Root cause', 'Fix', 'Prevention', 'Owner'];

const HINTS: Record<string, string> = {
  Timeline: 'When each thing happened, with the timezone: detected, mitigated, resolved.',
  Impact: 'What was down, for whom, and for how long.',
  'Root cause': 'Why it happened, not just what broke.',
  Fix: 'What restored service, and what was changed for good.',
  Prevention: 'One step per line, each with its follow-up ticket: "- Alert on disk at 80% (OPS-12)".',
  Owner: 'The person who drives the prevention steps to done.',
};

export function incidentTemplate(source: string | null): string {
  return [
    ...(source ? [`Started from ${source}.`, ''] : []),
    ...INCIDENT_SECTIONS.flatMap((s) => [`## ${s}`, '', `> Covers: ${HINTS[s]}`, '']),
  ].join('\n');
}

/** The section's text, without the template's hint lines. */
function section(text: string, title: string): string {
  const lines = text.split('\n');
  const at = lines.findIndex((l) => /^#{1,3}\s/.test(l) && l.replace(/^#+\s*/, '').trim().toLowerCase() === title.toLowerCase());
  if (at < 0) return '';
  const body: string[] = [];
  for (const line of lines.slice(at + 1)) {
    if (/^#{1,3}\s/.test(line)) break;
    if (!/^>\s*Covers:/.test(line)) body.push(line);
  }
  return body.join('\n').trim();
}

export class Incidents {
  constructor(private readonly store: Store) {}

  /** Opens an incident ticket, from a message (its thread is linked) or from scratch. */
  open(actor: Participant, project: string, input: { title: string; messageId?: number; tags?: string[] }): Ticket {
    const p = this.store.visibleProject(actor, project);
    let source: string | null = null;
    if (input.messageId !== undefined) {
      const exists = this.store.db.prepare('SELECT 1 FROM messages WHERE id = ?').get(input.messageId);
      if (!exists) throw new OrcoError('not_found', `No message ${input.messageId}`);
      const message = this.store.message(input.messageId);
      this.store.room(actor, message.room); // not_found unless the actor can see it
      source = `message ${message.id} in #${message.room} (open it in the room, or read it with read: room "${message.room}")`;
    }
    const labels = this.store.tickets.plan(actor, project).labels.map((l) => l.name.toLowerCase());
    if (!labels.includes(INCIDENT_LABEL)) this.store.tickets.createLabel(actor, project, INCIDENT_LABEL, '#e5484d');
    const tags = (input.tags ?? []).map((t) => t.trim().toLowerCase()).filter(Boolean);
    for (const tag of tags) if (!labels.includes(tag) && tag !== INCIDENT_LABEL) this.store.tickets.createLabel(actor, project, tag);
    const { ticket } = this.store.tickets.create(actor, p.name, {
      title: input.title,
      description: incidentTemplate(source),
      labels: [INCIDENT_LABEL, ...tags.filter((t) => t !== INCIDENT_LABEL)],
      priority: 'urgent',
    });
    return ticket;
  }

  /** What an incident still needs before it closes: empty sections, and prevention steps with no ticket. */
  missing(projectId: number, description: string): string[] {
    const out = missingSections(description, INCIDENT_SECTIONS).map((s) => `${s} is empty`);
    const prevention = section(description, 'Prevention');
    if (prevention) {
      const key = (this.store.db.prepare('SELECT ticket_key FROM projects WHERE id = ?').get(projectId) as { ticket_key: string }).ticket_key;
      for (const line of prevention.split('\n').map((l) => l.trim()).filter((l) => /^[-*\d]/.test(l))) {
        const refs = [...line.matchAll(/\b([A-Z][A-Z0-9]{0,9})-(\d+)\b/g)];
        const linked = refs.some((m) => {
          const projectOf = m[1] === key ? projectId : (this.store.db.prepare('SELECT id FROM projects WHERE ticket_key = ?').get(m[1]!) as { id: number } | undefined)?.id;
          return projectOf !== undefined && this.store.db.prepare('SELECT 1 FROM tickets WHERE project_id = ? AND number = ?').get(projectOf, Number(m[2])) !== undefined;
        });
        if (!linked) out.push(`the prevention step "${line.replace(/^[-*\d.)\s]+/, '').slice(0, 80)}" has no follow-up ticket`);
      }
    }
    return out;
  }

  /** Refuses closing an incident Done while it is missing something. */
  assertMayClose(projectId: number, labels: string[], description: string, ref: string): void {
    if (!labels.some((l) => l.toLowerCase() === INCIDENT_LABEL)) return;
    const missing = this.missing(projectId, description);
    if (missing.length) throw new OrcoError('conflict', `Incident ${ref} cannot close yet: ${missing.join('; ')}.`);
  }

  /** A project's incidents, newest first, optionally by tag, with their root cause. */
  list(actor: Participant, project: string, tag?: string): { ref: string; title: string; status: string; tags: string[]; rootCause: string; closed: boolean }[] {
    const tickets = this.store.tickets.list(actor, { project, label: INCIDENT_LABEL, limit: 500 });
    return tickets
      .filter((t) => !tag || t.labels.some((l) => l.name.toLowerCase() === tag.toLowerCase()))
      .map((t) => {
        const full = this.store.tickets.get(actor, t.ref);
        return {
          ref: t.ref,
          title: t.title,
          status: t.status.name,
          tags: t.labels.map((l) => l.name).filter((n) => n.toLowerCase() !== INCIDENT_LABEL),
          rootCause: section(full.description, 'Root cause'),
          closed: t.status.category === 'completed' || t.status.category === 'canceled',
        };
      })
      .sort((a, b) => b.ref.localeCompare(a.ref, undefined, { numeric: true }));
  }
}
