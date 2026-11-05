import { OrcoError } from './errors.js';
import type { Participant, Store } from './store.js';

/*
 * What each agent may do in Orco (#131), enforced by the server.
 *
 * Every MCP tool says what it touches. An agent's level (set by its owner, capped by org admins) is
 * a set of those areas: buildMcpServer registers only the tools whose area is allowed, and the same
 * areas gate an agent's writes over REST. A tool missing from TOOLS fails the test suite, and the
 * read-only hint every client sees comes from here too.
 */
export const AREAS = ['read', 'self', 'post', 'tickets', 'locks', 'tasks', 'schedules', 'secrets'] as const;
export type Area = (typeof AREAS)[number];

export const AREA_TEXT: Record<Area, string> = {
  read: 'read rooms, tickets, tasks, files and notes',
  self: 'its own notes, profile, reminders, and progress on its own tasks',
  post: 'post messages, ask and answer questions, request approvals and reviews',
  tickets: 'create and change tickets, folders, milestones, cycles, incidents and project files',
  locks: 'take and release locks',
  tasks: 'give tasks to other agents',
  schedules: 'schedule tasks',
  secrets: 'list, request and use secrets',
};

export const TOOLS: Record<string, Area> = {
  // Reading.
  whoami: 'read',
  my_work: 'read',
  list_participants: 'read',
  list_projects: 'read',
  list_rooms: 'read',
  read: 'read',
  view_image: 'read',
  read_file: 'read',
  search: 'read',
  search_knowledge: 'read',
  my_notes: 'read',
  ack_mentions: 'read',
  wait_for_mentions: 'read',
  wait_for: 'read',
  catch_up: 'read',
  list_tasks: 'read',
  get_task: 'read',
  decisions: 'read',
  get_approval: 'read',
  list_locks: 'read',
  project_plan: 'read',
  list_tickets: 'read',
  get_ticket: 'read',
  ticket_pack: 'read',
  list_ticket_files: 'read',
  read_ticket_file: 'read',
  list_artifacts: 'read',
  read_artifact: 'read',
  day_report: 'read',
  list_incidents: 'read',
  list_folders: 'read',
  project_notes: 'read',
  project_files: 'read',
  read_project_file: 'read',
  list_schedules: 'read',
  my_feedback: 'read',
  find_agent: 'read',
  summarize_thread: 'read',
  org_notes: 'read',
  outline_search: 'read',
  outline_read: 'read',
  // Its own things.
  remember: 'self',
  forget: 'self',
  set_profile: 'self',
  remind_me: 'self',
  cancel_reminder: 'self',
  report_usage: 'self',
  report_progress: 'self',
  checkpoint: 'self',
  update_task: 'self',
  // Speaking.
  post: 'post',
  create_room: 'post',
  set_room_status: 'post',
  request_review: 'post',
  withdraw_review: 'post',
  submit_review: 'post',
  ask_question: 'post',
  answer_question: 'post',
  request_approval: 'post',
  propose_plan: 'post',
  flag_message: 'post',
  publish_artifact: 'post',
  propose_org_note: 'post',
  forget_org_note: 'post',
  outline_publish: 'post',
  // Tickets and project records.
  create_ticket: 'tickets',
  create_tickets: 'tickets',
  update_ticket: 'tickets',
  update_tickets: 'tickets',
  comment_ticket: 'tickets',
  start_ticket: 'tickets',
  claim_ticket: 'tickets',
  create_label: 'tickets',
  create_folder: 'tickets',
  create_milestone: 'tickets',
  update_milestone: 'tickets',
  create_cycle: 'tickets',
  complete_cycle: 'tickets',
  open_incident: 'tickets',
  write_project_file: 'tickets',
  save_note: 'tickets',
  // Shared resources and other agents.
  acquire_lock: 'locks',
  renew_lock: 'locks',
  release_lock: 'locks',
  create_task: 'tasks',
  start_ticket_task: 'tasks',
  reassign_task: 'tasks',
  schedule_task: 'schedules',
  change_schedule: 'schedules',
  list_secrets: 'secrets',
  request_secret: 'secrets',
  use_secret: 'secrets',
};

export const READ_ONLY_TOOLS = new Set(Object.entries(TOOLS).filter(([, area]) => area === 'read').map(([name]) => name));

export const LEVELS = {
  read_only: ['read'],
  comment: ['read', 'self', 'post'],
  work_tickets: ['read', 'self', 'post', 'tickets', 'locks'],
  full: [...AREAS],
} as const satisfies Record<string, readonly Area[]>;
export type Level = keyof typeof LEVELS | 'custom';
export const LEVEL_TEXT: Record<Level, string> = { read_only: 'Read only', comment: 'Comment', work_tickets: 'Work tickets', full: 'Full', custom: 'Custom' };
const ORDER: Level[] = ['read_only', 'comment', 'work_tickets', 'full'];

export interface ToolAccess {
  level: Level;
  /** The areas the agent has after the org cap. */
  areas: Area[];
  /** The org admins' cap, if any, and who set it. */
  cap: { level: Exclude<Level, 'custom'>; by: string } | null;
}

function checkLevel(level: string): Level {
  if (level === 'custom' || level in LEVELS) return level as Level;
  throw new OrcoError('invalid', `Levels are ${[...ORDER, 'custom'].join(', ')}`);
}

function checkAreas(areas: unknown): Area[] {
  if (!Array.isArray(areas) || !areas.length) throw new OrcoError('invalid', `A custom level lists areas: ${AREAS.join(', ')}`);
  const bad = areas.filter((a) => !AREAS.includes(a as Area));
  if (bad.length) throw new OrcoError('invalid', `Unknown area ${bad.join(', ')}; areas are ${AREAS.join(', ')}`);
  // Reading comes with everything: an agent that cannot read cannot work.
  return [...new Set<Area>(['read', ...(areas as Area[])])];
}

export class ToolLevels {
  constructor(private readonly store: Store) {}

  cap(): ToolAccess['cap'] {
    const row = this.store.db.prepare("SELECT value FROM org_settings WHERE key = 'tool_cap'").get() as { value: string } | undefined;
    return row ? (JSON.parse(row.value) as ToolAccess['cap']) : null;
  }

  /** What an agent may touch. People are not limited here. */
  access(agent: Participant): ToolAccess {
    const row = this.store.db.prepare('SELECT tool_level, tool_areas FROM participants WHERE id = ?').get(agent.id) as { tool_level: string | null; tool_areas: string | null } | undefined;
    const level = (row?.tool_level ?? 'full') as Level;
    const own: Area[] = level === 'custom' ? (JSON.parse(row?.tool_areas ?? '["read"]') as Area[]) : [...LEVELS[level as keyof typeof LEVELS]];
    const cap = this.cap();
    const areas = cap ? own.filter((a) => (LEVELS[cap.level] as readonly Area[]).includes(a)) : own;
    return { level, areas, cap };
  }

  allows(actor: Participant, area: Area): boolean {
    return actor.kind !== 'agent' || this.access(actor).areas.includes(area);
  }

  assert(actor: Participant, area: Area): void {
    if (this.allows(actor, area)) return;
    const { level } = this.access(actor);
    throw new OrcoError('forbidden', `${actor.name} is set to ${LEVEL_TEXT[level]}, which does not include: ${AREA_TEXT[area]}. Its owner can change that.`);
  }

  /** The owner (or an org admin) sets an agent's level. Agents never change their own or others'. */
  set(actor: Participant, agentName: string, level: string, areas?: unknown): ToolAccess {
    if (actor.kind !== 'user') throw new OrcoError('forbidden', 'Only people set what agents may do');
    const agent = this.store.participantByName(agentName);
    if (!agent || agent.kind !== 'agent') throw new OrcoError('not_found', `No agent ${agentName}`);
    if (agent.ownerId !== actor.id && !this.store.isOrgAdmin(actor)) throw new OrcoError('forbidden', `Only ${agentName}'s owner or an org admin sets what it may do`);
    const checked = checkLevel(level);
    const custom = checked === 'custom' ? checkAreas(areas) : null;
    this.store.db.prepare('UPDATE participants SET tool_level = ?, tool_areas = ? WHERE id = ?').run(checked === 'full' ? null : checked, custom ? JSON.stringify(custom) : null, agent.id);
    this.store.audit.record(actor, 'agent.tool_level', { projectId: null, subject: `agent:${agent.name}`, detail: { level: checked, areas: custom } });
    return this.access(agent);
  }

  /** Org admins cap every agent at a level (null lifts it). */
  setCap(actor: Participant, level: string | null): ToolAccess['cap'] {
    if (actor.kind !== 'user' || !this.store.isOrgAdmin(actor)) throw new OrcoError('forbidden', 'Only org admins cap what agents may do');
    if (level === null) this.store.db.prepare("DELETE FROM org_settings WHERE key = 'tool_cap'").run();
    else {
      const checked = checkLevel(level);
      if (checked === 'custom') throw new OrcoError('invalid', 'The cap is one of read_only, comment, work_tickets, full');
      this.store.db
        .prepare("INSERT INTO org_settings (key, value) VALUES ('tool_cap', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value")
        .run(JSON.stringify({ level: checked, by: actor.name }));
    }
    this.store.audit.record(actor, 'agent.tool_cap', { projectId: null, subject: 'org', detail: { level } });
    return this.cap();
  }
}

/**
 * The area a REST write touches, for agents' tokens (#131). Reads (GET) are always 'read'. A write
 * not listed here needs every area: new routes are closed to limited agents until they are sorted.
 */
export function restArea(method: string, path: string): Area | 'all' {
  if (method === 'GET' || method === 'HEAD') return 'read';
  const p = path.replace(/\/+$/, '');
  const rules: [RegExp, Area][] = [
    [/^\/messages\/\d+\/(seen|ack)$/, 'read'],
    [/^\/(mentions|read-cursors|cursors)(\/|$)/, 'read'],
    [/^\/tasks\/\d+\/secrets/, 'secrets'],
    [/^\/secrets(\/|$)/, 'secrets'],
    [/^\/tasks\/\d+\/(progress|checkpoint|state|update|token|reminders|runs?|usage|seen)(\/|$)/, 'self'],
    [/^\/tasks\/\d+$/, 'self'],
    [/^\/tasks\/\d+\/questions$/, 'post'],
    [/^\/tasks\/\d+\/reassign$/, 'tasks'],
    [/^\/tasks$/, 'tasks'],
    [/^\/schedules(\/|$)/, 'schedules'],
    [/^\/locks(\/|$)/, 'locks'],
    [/^\/(tickets|ticket-files|folders|labels|milestones|cycles|incidents|notes)(\/|$)/, 'tickets'],
    [/^\/projects\/[^/]+\/(tickets|files?|notes|folders|labels|milestones|cycles|plans)(\/|$)/, 'tickets'],
    [/^\/(messages|attachments|questions|approvals|reviews|artifacts|room-status|org-notes)(\/|$)/, 'post'],
    [/^\/outline\/publish$/, 'post'],
    [/^\/outline\/(search|read|preview|collections)$/, 'read'],
    [/^\/rooms\/[^/]+(\/[^/]+)?\/status$/, 'post'],
    [/^\/(memory|reminders|profile|runs|usage|presence)(\/|$)/, 'self'],
    [/^\/agents\/[^/]+\/memory(\/|$)/, 'self'],
  ];
  for (const [pattern, area] of rules) if (pattern.test(p)) return area;
  return 'all';
}
