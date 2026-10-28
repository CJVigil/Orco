import { OrcoError } from './errors.js';
import type { Participant, Store } from './store.js';
import { PRIORITIES, type Priority, type TicketInput } from './tickets.js';

/** One ticket to import. `key` names it within the file so `parent` and `blockedBy` can point at it. */
export interface ImportRow {
  key?: string;
  title: string;
  description?: string;
  status?: string;
  priority?: string;
  estimate?: number | null;
  dueDate?: string | null;
  assignee?: string | null;
  labels?: string[];
  milestone?: string | null;
  cycle?: number | 'current' | null;
  /** A key in this file, or an existing ticket like API-3. */
  parent?: string | null;
  blockedBy?: string[];
  blockedReason?: string;
  criteria?: string[];
}

export interface ImportOptions {
  createLabels?: boolean;
  createMilestones?: boolean;
  dryRun?: boolean;
}

export interface ImportResult {
  dryRun: boolean;
  created: { row: number; key: string | null; ref: string | null; title: string }[];
  labelsCreated: string[];
  milestonesCreated: string[];
}

export const MAX_IMPORT = 1_000;

/**
 * Files tickets in bulk for a person, e.g. when moving from a spreadsheet or another tracker. Every
 * row is checked before anything is written; on any problem nothing is imported and the error names
 * the row. Imported tickets never start tasks, even when assigned to an agent.
 */
export function importTickets(store: Store, actor: Participant, project: string, rows: ImportRow[], options: ImportOptions = {}): ImportResult {
  if (actor.kind !== 'user') throw new OrcoError('forbidden', 'Imports are run by people');
  if (!Array.isArray(rows) || rows.length === 0) throw new OrcoError('invalid', 'Nothing to import');
  if (rows.length > MAX_IMPORT) throw new OrcoError('invalid', `Import at most ${MAX_IMPORT} tickets at a time`);
  const plan = store.tickets.plan(actor, project);
  const has = (list: { name: string }[], name: string) => list.some((x) => x.name.toLowerCase() === name.toLowerCase());
  const keys = new Map<string, number>();
  const newLabels = new Set<string>();
  const newMilestones = new Set<string>();
  const fail = (i: number, message: string): never => {
    throw new OrcoError('invalid', `Row ${i + 1}${rows[i]?.key ? ` (${rows[i]!.key})` : ''}: ${message}`);
  };

  rows.forEach((row, i) => {
    if (typeof row !== 'object' || row === null) fail(i, 'expected an object');
    if (typeof row.title !== 'string' || !row.title.trim()) fail(i, 'title is required');
    if (row.dueDate !== undefined && row.dueDate !== null && typeof row.dueDate !== 'string') fail(i, 'due date must be a string');
    if (row.key !== undefined) {
      if (typeof row.key !== 'string' || !row.key.trim()) fail(i, 'key must be a non-empty string');
      if (keys.has(row.key)) fail(i, `key ${row.key} is used twice`);
      keys.set(row.key, i);
    }
    if (row.status && !plan.statuses.some((s) => s.name.toLowerCase() === row.status!.toLowerCase())) {
      fail(i, `no status ${row.status}; use one of ${plan.statuses.map((s) => s.name).join(', ')}`);
    }
    if (row.priority && !PRIORITIES.includes(row.priority as Priority)) fail(i, `priority must be one of ${PRIORITIES.join(', ')}`);
    if (row.title.trim().length > 200) fail(i, 'title is over 200 characters');
    if ((row.description ?? '').length > 20_000) fail(i, 'description is over 20000 characters');
    if (row.estimate !== undefined && row.estimate !== null && (!Number.isInteger(row.estimate) || row.estimate < 0 || row.estimate > 100)) {
      fail(i, 'estimate must be a whole number of points from 0 to 100');
    }
    if (row.dueDate && (!/^\d{4}-\d{2}-\d{2}$/.test(row.dueDate) || new Date(`${row.dueDate}T00:00:00Z`).toISOString().slice(0, 10) !== row.dueDate)) {
      fail(i, 'due date must be a date like 2026-11-30');
    }
    if (row.cycle !== undefined && row.cycle !== null) {
      const cycle = row.cycle === 'current' ? plan.cycles.find((c) => c.current) : plan.cycles.find((c) => c.number === row.cycle);
      if (!cycle) fail(i, row.cycle === 'current' ? 'there is no current cycle' : `no cycle ${row.cycle}`);
      if (cycle?.completedAt) fail(i, `cycle ${cycle.number} is complete`);
    }
    if ((row.criteria ?? []).length > 50 || (row.criteria ?? []).some((c) => c.length > 300)) fail(i, 'at most 50 criteria of up to 300 characters');
    if ((row.blockedReason ?? '').length > 200) fail(i, 'blocked reason is over 200 characters');
    if (row.assignee && !plan.members.some((m) => m.name === row.assignee)) fail(i, `${row.assignee} is not in ${plan.project}`);
    for (const label of row.labels ?? []) {
      if (!has(plan.labels, label)) {
        if (!options.createLabels) fail(i, `no label ${label}; create it first or import with createLabels`);
        newLabels.add(label.trim());
      }
    }
    if (row.milestone && !has(plan.milestones, row.milestone)) {
      if (!options.createMilestones) fail(i, `no milestone ${row.milestone}; create it first or import with createMilestones`);
      newMilestones.add(row.milestone.trim());
    }
  });
  // References may point at rows anywhere in the file, or at tickets that already exist.
  rows.forEach((row, i) => {
    for (const ref of [...(row.parent ? [row.parent] : []), ...(row.blockedBy ?? [])]) {
      if (keys.has(ref)) continue;
      try {
        store.tickets.get(actor, ref);
      } catch {
        fail(i, `${ref} is neither a key in this file nor a ticket you can see`);
      }
    }
    if (row.parent && row.key && row.parent === row.key) fail(i, 'a ticket cannot be its own parent');
  });

  const result: ImportResult = { dryRun: Boolean(options.dryRun), created: [], labelsCreated: [...newLabels], milestonesCreated: [...newMilestones] };
  if (options.dryRun) {
    result.created = rows.map((row, i) => ({ row: i + 1, key: row.key ?? null, ref: null, title: row.title.trim() }));
    return result;
  }

  for (const name of newLabels) store.tickets.createLabel(actor, project, name);
  for (const name of newMilestones) store.tickets.createMilestone(actor, project, { name });
  // Parents first, so a child can name a parent that comes later in the file.
  const refs = new Map<string, string>();
  const order = parentsFirst(rows, keys);
  for (const i of order) {
    const row = rows[i]!;
    const parent = row.parent ? (refs.get(row.parent) ?? (keys.has(row.parent) ? undefined : row.parent)) : undefined;
    const input: TicketInput & { title: string } = {
      title: row.title,
      description: row.description,
      status: row.status || undefined,
      priority: (row.priority || undefined) as Priority | undefined,
      estimate: row.estimate ?? undefined,
      dueDate: row.dueDate ?? undefined,
      assignee: row.assignee || undefined,
      labels: row.labels,
      milestone: row.milestone || undefined,
      cycle: row.cycle ?? undefined,
      parent,
      blockedReason: row.blockedReason,
      criteriaAdd: row.criteria,
      // Blockers that are existing tickets can be linked now; ones in this file are linked below.
      blockedByAdd: (row.blockedBy ?? []).filter((ref) => !keys.has(ref)),
    };
    const { ticket } = store.tickets.create(actor, project, input, { dispatch: false });
    if (row.key) refs.set(row.key, ticket.ref);
    result.created.push({ row: i + 1, key: row.key ?? null, ref: ticket.ref, title: ticket.title });
  }
  rows.forEach((row) => {
    const local = (row.blockedBy ?? []).filter((ref) => keys.has(ref)).map((ref) => refs.get(ref)!);
    if (local.length) store.tickets.update(actor, refs.get(row.key!) ?? '', { blockedByAdd: local });
  });
  result.created.sort((a, b) => a.row - b.row);
  store.audit.record(actor, 'ticket.import', {
    projectId: store.visibleProject(actor, project).id,
    subject: `project:${project}`,
    detail: { tickets: result.created.length, labelsCreated: result.labelsCreated, milestonesCreated: result.milestonesCreated },
  });
  return result;
}

function parentsFirst(rows: ImportRow[], keys: Map<string, number>): number[] {
  const order: number[] = [];
  const state = new Map<number, 'visiting' | 'done'>();
  const visit = (i: number) => {
    if (state.get(i) === 'done') return;
    if (state.get(i) === 'visiting') throw new OrcoError('invalid', `Row ${i + 1}: parents form a loop`);
    state.set(i, 'visiting');
    const parent = rows[i]!.parent;
    if (parent && keys.has(parent)) visit(keys.get(parent)!);
    state.set(i, 'done');
    order.push(i);
  };
  rows.forEach((_, i) => visit(i));
  return order;
}

/** Parses an import file: a JSON array (or `{ "tickets": [...] }`), or CSV with a header row. */
export function parseImport(text: string, format: 'json' | 'csv'): ImportRow[] {
  if (format === 'json') {
    let data: unknown;
    try {
      data = JSON.parse(text);
    } catch (err) {
      throw new OrcoError('invalid', `Not valid JSON: ${(err as Error).message}`);
    }
    const rows = Array.isArray(data) ? data : (data as { tickets?: unknown })?.tickets;
    if (!Array.isArray(rows)) throw new OrcoError('invalid', 'Expected a JSON array of tickets, or { "tickets": [...] }');
    return rows as ImportRow[];
  }
  const table = parseCsv(text);
  const [header, ...body] = table;
  if (!header) throw new OrcoError('invalid', 'The CSV is empty');
  const names = header.map((h) => h.trim().toLowerCase().replace(/[\s-]+/g, '_'));
  const list = (value: string) => value.split(/[;|]/).map((v) => v.trim()).filter(Boolean);
  return body
    .filter((cells) => cells.some((c) => c.trim()))
    .map((cells) => {
      const get = (...aliases: string[]) => {
        for (const alias of aliases) {
          const i = names.indexOf(alias);
          if (i !== -1 && cells[i]?.trim()) return cells[i]!.trim();
        }
        return undefined;
      };
      const estimate = get('estimate', 'points');
      const cycle = get('cycle');
      return {
        key: get('key', 'id'),
        title: get('title', 'summary', 'name') ?? '',
        description: get('description', 'body', 'details'),
        status: get('status', 'state'),
        priority: get('priority')?.toLowerCase(),
        estimate: estimate === undefined ? undefined : Number(estimate),
        dueDate: get('due_date', 'duedate', 'due'),
        assignee: get('assignee', 'owner'),
        labels: list(get('labels', 'label', 'tags') ?? ''),
        milestone: get('milestone'),
        cycle: cycle === undefined ? undefined : cycle === 'current' ? 'current' : Number(cycle),
        parent: get('parent'),
        blockedBy: list(get('blocked_by', 'blockedby', 'blockers', 'depends_on') ?? ''),
        blockedReason: get('blocked_reason', 'blockedreason', 'blocked'),
        criteria: list(get('criteria', 'acceptance_criteria') ?? ''),
      };
    });
}

/** RFC 4180 CSV: commas, double-quoted fields, doubled quotes, newlines inside quotes. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  const input = text.replace(/^﻿/, '');
  for (let i = 0; i < input.length; i++) {
    const ch = input[i]!;
    if (quoted) {
      if (ch === '"' && input[i + 1] === '"') {
        field += '"';
        i++;
      } else if (ch === '"') {
        quoted = false;
      } else {
        field += ch;
      }
    } else if (ch === '"' && field === '') {
      quoted = true;
    } else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && input[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else {
      field += ch;
    }
  }
  if (quoted) throw new OrcoError('invalid', 'The CSV has an unclosed quote');
  if (field !== '' || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}
