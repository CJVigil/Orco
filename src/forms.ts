import { OrcoError } from './errors.js';
import type { Participant, Store } from './store.js';
import type { Priority, TicketInput } from './tickets.js';

/*
 * Intake forms (#134): per-project forms so a report from a phone arrives complete. A form has
 * fields (text, number, choice, person, item code, location, photo), each required or optional, and
 * sets the new ticket's labels, folder, assignee, priority and who it waits on. Filling one writes
 * the description in a fixed `Field: value` layout that agents can parse, and refuses missing
 * required fields by name. People and agents file through the same path.
 */
export const FIELD_TYPES = ['text', 'number', 'choice', 'person', 'item', 'location', 'photo'] as const;
export type FieldType = (typeof FIELD_TYPES)[number];

export interface FormField {
  label: string;
  type: FieldType;
  required: boolean;
  /** Choices, for type choice. */
  options?: string[];
}

export interface FormDefaults {
  labels: string[];
  folder: string | null;
  assignee: string | null;
  priority: Priority | null;
  waitingOn: string | null;
}

export interface TicketForm extends FormDefaults {
  id: number;
  project: string;
  name: string;
  hint: string;
  fields: FormField[];
}

const MAX_FIELDS = 15;
const MAX_FORMS = 20;
const MAX_VALUE = 1000;

function checkFields(input: unknown): FormField[] {
  if (!Array.isArray(input) || !input.length) throw new OrcoError('invalid', 'A form has at least one field');
  if (input.length > MAX_FIELDS) throw new OrcoError('invalid', `At most ${MAX_FIELDS} fields`);
  const seen = new Set<string>();
  return input.map((raw, i) => {
    const f = (raw ?? {}) as Record<string, unknown>;
    const label = String(f.label ?? '').trim();
    if (!label || label.length > 60 || /[:\n]/.test(label)) throw new OrcoError('invalid', `Field ${i + 1}: a label of 1-60 characters, without a colon`);
    if (seen.has(label.toLowerCase())) throw new OrcoError('invalid', `Two fields are called ${label}`);
    seen.add(label.toLowerCase());
    const type = String(f.type ?? 'text') as FieldType;
    if (!FIELD_TYPES.includes(type)) throw new OrcoError('invalid', `${label}: the type is one of ${FIELD_TYPES.join(', ')}`);
    const options = type === 'choice' ? (Array.isArray(f.options) ? f.options : String(f.options ?? '').split(',')).map((o) => String(o).trim()).filter(Boolean).slice(0, 20) : undefined;
    if (type === 'choice' && !options!.length) throw new OrcoError('invalid', `${label}: list the choices`);
    return { label, type, required: f.required === true, ...(options ? { options } : {}) };
  });
}

/** The value of a field from the given values, matched by label without regard to case. */
function valueFor(values: Record<string, unknown>, label: string): unknown {
  const key = Object.keys(values).find((k) => k.trim().toLowerCase() === label.toLowerCase());
  return key === undefined ? undefined : values[key];
}

/**
 * The description, title and checks for a filled form. Missing required fields are refused by name,
 * all at once, so a person fixes them in one go.
 */
export function fillForm(form: Pick<TicketForm, 'name' | 'fields'>, values: Record<string, unknown>, extra: { title?: string; notes?: string; photos?: number }) {
  const missing: string[] = [];
  const lines: string[] = [];
  let first = '';
  for (const field of form.fields) {
    const raw = valueFor(values, field.label);
    let value = raw === undefined || raw === null ? '' : String(raw).replace(/\s+/g, ' ').trim();
    if (field.type === 'photo') {
      if (field.required && !extra.photos) missing.push(field.label);
      if (extra.photos) lines.push(`${field.label}: ${extra.photos} attached`);
      continue;
    }
    if (!value) {
      if (field.required) missing.push(field.label);
      continue;
    }
    if (value.length > MAX_VALUE) throw new OrcoError('invalid', `${field.label} is at most ${MAX_VALUE} characters`);
    if (field.type === 'number' && !Number.isFinite(Number(value))) throw new OrcoError('invalid', `${field.label} is a number`);
    if (field.type === 'choice' && !field.options!.some((o) => o.toLowerCase() === value.toLowerCase())) {
      throw new OrcoError('invalid', `${field.label} is one of ${field.options!.join(', ')}`);
    }
    if (field.type === 'choice') value = field.options!.find((o) => o.toLowerCase() === value.toLowerCase())!;
    if (field.type === 'person') value = value.replace(/^@/, '');
    if (!first) first = value;
    lines.push(`${field.label}: ${value}`);
  }
  if (missing.length) throw new OrcoError('invalid', `${form.name} needs ${missing.join(', ')}`);
  const notes = extra.notes?.trim();
  const description = `Form: ${form.name}\n${lines.join('\n')}${notes ? `\n\n${notes}` : ''}`;
  const title = extra.title?.trim() || `${form.name}${first ? `: ${first}` : ''}`.slice(0, 200);
  return { title, description };
}

interface Row {
  id: number;
  project: string;
  name: string;
  hint: string;
  fields: string;
  defaults: string;
}

export class Forms {
  constructor(private readonly store: Store) {}

  private toForm(row: Row): TicketForm {
    const d = JSON.parse(row.defaults) as Partial<FormDefaults>;
    return {
      id: row.id,
      project: row.project,
      name: row.name,
      hint: row.hint,
      fields: JSON.parse(row.fields) as FormField[],
      labels: d.labels ?? [],
      folder: d.folder ?? null,
      assignee: d.assignee ?? null,
      priority: d.priority ?? null,
      waitingOn: d.waitingOn ?? null,
    };
  }

  list(actor: Participant, project: string): TicketForm[] {
    const p = this.store.visibleProject(actor, project);
    return (
      this.store.db.prepare('SELECT f.id, pr.name AS project, f.name, f.hint, f.fields, f.defaults FROM ticket_forms f JOIN projects pr ON pr.id = f.project_id WHERE f.project_id = ? ORDER BY f.name').all(p.id) as unknown as Row[]
    ).map((r) => this.toForm(r));
  }

  find(actor: Participant, project: string, name: string): TicketForm {
    const form = this.list(actor, project).find((f) => f.name.toLowerCase() === name.trim().toLowerCase());
    if (!form) throw new OrcoError('not_found', `${project} has no form called ${name}; project_plan lists its forms`);
    return form;
  }

  private assertAdmin(actor: Participant, projectId: number) {
    if (actor.kind !== 'user') throw new OrcoError('forbidden', 'Only people set up intake forms');
    if (this.store.roleIn(actor, projectId) !== 'admin' && !this.store.isOrgAdmin(actor)) throw new OrcoError('forbidden', 'Only project admins set up intake forms');
  }

  private checked(input: { name?: string; hint?: string; fields?: unknown; labels?: unknown; folder?: unknown; assignee?: unknown; priority?: unknown; waitingOn?: unknown }) {
    const name = String(input.name ?? '').trim();
    if (!name || name.length > 60) throw new OrcoError('invalid', 'Name the form in 1-60 characters, like "Damaged pallet"');
    const hint = String(input.hint ?? '').trim().slice(0, 200);
    const fields = checkFields(input.fields);
    const labels = (Array.isArray(input.labels) ? input.labels : String(input.labels ?? '').split(',')).map((l) => String(l).trim()).filter(Boolean).slice(0, 10);
    const opt = (v: unknown) => (v === undefined || v === null || String(v).trim() === '' ? null : String(v).trim().replace(/^@/, ''));
    const priority = opt(input.priority) as Priority | null;
    if (priority && !['urgent', 'high', 'medium', 'low', 'none'].includes(priority)) throw new OrcoError('invalid', 'Priority is urgent, high, medium, low or none');
    return { name, hint, fields, defaults: { labels, folder: opt(input.folder), assignee: opt(input.assignee), priority, waitingOn: opt(input.waitingOn) } satisfies FormDefaults };
  }

  /** A form's labels exist once it is saved: the admin saving it creates any that are missing. */
  private ensureLabels(actor: Participant, project: string, labels: string[]) {
    const have = new Set(this.store.tickets.plan(actor, project).labels.map((l) => l.name.toLowerCase()));
    for (const label of labels) if (!have.has(label.toLowerCase())) this.store.tickets.createLabel(actor, project, label);
  }

  create(actor: Participant, project: string, input: Parameters<Forms['checked']>[0]): TicketForm {
    const p = this.store.visibleProject(actor, project);
    this.assertAdmin(actor, p.id);
    const c = this.checked(input);
    const count = (this.store.db.prepare('SELECT count(*) AS n FROM ticket_forms WHERE project_id = ?').get(p.id) as { n: number }).n;
    if (count >= MAX_FORMS) throw new OrcoError('conflict', `${p.name} has ${MAX_FORMS} forms already`);
    if (this.list(actor, project).some((f) => f.name.toLowerCase() === c.name.toLowerCase())) throw new OrcoError('conflict', `${p.name} already has a form called ${c.name}`);
    this.ensureLabels(actor, p.name, c.defaults.labels);
    const { lastInsertRowid } = this.store.db
      .prepare('INSERT INTO ticket_forms (project_id, name, hint, fields, defaults, created_by, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(p.id, c.name, c.hint, JSON.stringify(c.fields), JSON.stringify(c.defaults), actor.id, new Date(this.store.now()).toISOString());
    this.store.audit.record(actor, 'form.create', { projectId: p.id, subject: `form:${lastInsertRowid}`, detail: { name: c.name } });
    return this.find(actor, project, c.name);
  }

  update(actor: Participant, id: number, input: Parameters<Forms['checked']>[0]): TicketForm {
    const row = this.store.db.prepare('SELECT f.project_id, p.name AS project FROM ticket_forms f JOIN projects p ON p.id = f.project_id WHERE f.id = ?').get(id) as { project_id: number; project: string } | undefined;
    if (!row || !this.store.canSee(actor, row.project_id)) throw new OrcoError('not_found', `No form ${id}`);
    this.assertAdmin(actor, row.project_id);
    const c = this.checked(input);
    this.ensureLabels(actor, row.project, c.defaults.labels);
    this.store.db.prepare('UPDATE ticket_forms SET name = ?, hint = ?, fields = ?, defaults = ?, updated_at = ? WHERE id = ?').run(c.name, c.hint, JSON.stringify(c.fields), JSON.stringify(c.defaults), new Date(this.store.now()).toISOString(), id);
    this.store.audit.record(actor, 'form.update', { projectId: row.project_id, subject: `form:${id}`, detail: { name: c.name } });
    return this.find(actor, row.project, c.name);
  }

  delete(actor: Participant, id: number): void {
    const row = this.store.db.prepare('SELECT project_id, name FROM ticket_forms WHERE id = ?').get(id) as { project_id: number; name: string } | undefined;
    if (!row || !this.store.canSee(actor, row.project_id)) throw new OrcoError('not_found', `No form ${id}`);
    this.assertAdmin(actor, row.project_id);
    this.store.db.prepare('DELETE FROM ticket_forms WHERE id = ?').run(id);
    this.store.audit.record(actor, 'form.delete', { projectId: row.project_id, subject: `form:${id}`, detail: { name: row.name } });
  }

  /**
   * The ticket input for a filled form: its description and title, plus the form's labels, folder,
   * assignee, priority and waiting-on. Anything the filer passes explicitly wins over the form.
   */
  ticketInput(actor: Participant, project: string, formName: string, values: Record<string, unknown>, input: TicketInput & { title?: string }): TicketInput & { title: string } {
    const form = this.find(actor, project, formName);
    const { title, description } = fillForm(form, values, { title: input.title, notes: input.description, photos: input.attachmentIds?.length ?? 0 });
    return {
      ...input,
      title,
      description,
      labels: [...new Set([...form.labels, ...(input.labels ?? [])])],
      ...(input.folder === undefined && form.folder ? { folder: form.folder } : {}),
      ...(input.assignee === undefined && form.assignee ? { assignee: form.assignee } : {}),
      ...(input.priority === undefined && form.priority ? { priority: form.priority } : {}),
      ...(input.waitingOn === undefined && form.waitingOn ? { waitingOn: form.waitingOn, waitingAsk: input.waitingAsk ?? `Look at this ${form.name} report` } : {}),
    };
  }
}
