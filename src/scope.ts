import { OrcoError } from './errors.js';
import type { Participant, Store } from './store.js';

/*
 * The scope gate (#108). A new project starts in Scope: its scoping/SCOPE.md must have content under
 * every section of the template, and an org or project admin (a person) approves it. Until then the
 * project's build tickets stay in Backlog (tickets labelled "scope" are the scoping work itself and
 * move freely), and an agent's request_approval for a repo, stack or deploy there is refused. The
 * approval is recorded as a decision pointing at the file version; writing SCOPE.md again after that
 * puts the project back in Scope until it is approved again. Projects made before the gate are not in it.
 */

export const SCOPE_PATH = 'scoping/SCOPE.md';
export const SCOPE_LABEL = 'scope';

/** The built-in template: the layout this team shipped a project with (decided 2026-11-03). */
export const DEFAULT_SECTIONS = [
  'Why this exists',
  'What already exists (do not rebuild)',
  'What the investigation established',
  'Operating mode, the decision',
  'Architecture, each choice with its reason',
  'Scope: Phase 1, later phases, explicitly out of scope',
  'What it owes other projects',
];

const SECTION_HINTS: Record<string, string> = {
  'Architecture, each choice with its reason': 'Storage, settings vs environment, cost accounting, data retention and privacy, alerting, deployment.',
};

export type ScopeState = 'none' | 'scoping' | 'approved';

export interface ScopeStatus {
  state: ScopeState;
  sections: string[];
  /** Sections with no content yet. */
  missing: string[];
  /** The SCOPE.md version that was approved, and by whom. */
  approvedVersion: number | null;
  approvedBy: string | null;
  decisionId: number | null;
  path: string;
  /** Whether SCOPE.md has been written yet. */
  exists: boolean;
}

/** A SCOPE.md to start from, with every section of the template. */
export function scopeTemplate(project: string, sections: string[]): string {
  return [
    `# ${project}: scope`,
    '',
    'Decisions only; keep the facts they rest on in scoping/reference/, and one scoping/<component>.md per surface',
    '(why it exists, principles, auth, endpoints, what is not here yet, operating it).',
    '',
    ...sections.flatMap((title, i) => [`## ${i + 1}. ${title}`, '', ...(SECTION_HINTS[title] ? [`> Covers: ${SECTION_HINTS[title]}`, ''] : [])]),
  ].join('\n');
}

/** The template's sections that have no content in this text (headings matched by title, numbers optional). */
export function missingSections(text: string, sections: string[]): string[] {
  const lines = text.split('\n');
  const norm = (s: string) => s.toLowerCase().replace(/^\s*\d+[.)]\s*/, '').replace(/[^a-z0-9]+/g, ' ').trim();
  return sections.filter((title) => {
    const at = lines.findIndex((l) => /^#{1,3}\s/.test(l) && norm(l.replace(/^#+\s*/, '')) === norm(title));
    if (at < 0) return true;
    const body: string[] = [];
    for (const line of lines.slice(at + 1)) {
      if (/^#{1,3}\s/.test(line)) break;
      body.push(line);
    }
    // Comments and the template's own "> Covers:" hints are not content.
    return !body.filter((l) => !/^>\s*Covers:/.test(l)).join('\n').replace(/<!--[\s\S]*?-->/g, '').trim();
  });
}

export class Scope {
  constructor(private readonly store: Store) {}

  /** Whether new projects start in Scope (an org setting; on unless ORCO_SCOPE_GATE=off). */
  gateNewProjects(): boolean {
    const row = this.store.db.prepare("SELECT value FROM org_settings WHERE key = 'scope_gate_new_projects'").get() as { value: string } | undefined;
    // An org admin's choice wins; until one is made, ORCO_SCOPE_GATE=off starts new projects without the gate.
    return row ? row.value === 'on' : process.env.ORCO_SCOPE_GATE !== 'off';
  }

  setGateNewProjects(actor: Participant, on: boolean): boolean {
    if (actor.kind !== 'user' || !this.store.isOrgAdmin(actor)) throw new OrcoError('forbidden', 'Only org admins change the scope gate');
    this.store.policyFile.assertUnlocked('org', 'scopeGate');
    this.store.db.prepare("INSERT INTO org_settings (key, value) VALUES ('scope_gate_new_projects', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value").run(on ? 'on' : 'off');
    this.store.audit.record(actor, 'scope.gate_default', { projectId: null, subject: 'org', detail: { on } });
    return on;
  }

  /** The sections every SCOPE.md needs: the org's template, or the built-in one. */
  sections(): string[] {
    const row = this.store.db.prepare("SELECT value FROM org_settings WHERE key = 'scope_sections'").get() as { value: string } | undefined;
    const list = row ? (JSON.parse(row.value) as string[]) : [];
    return list.length ? list : DEFAULT_SECTIONS;
  }

  /** Org admins set the template's sections (an empty list restores the built-in one). */
  setSections(actor: Participant, sections: string[]): string[] {
    if (actor.kind !== 'user' || !this.store.isOrgAdmin(actor)) throw new OrcoError('forbidden', 'Only org admins change the scope template');
    this.store.policyFile.assertUnlocked('org', 'scopeSections');
    const clean = [...new Set(sections.map((s) => s.trim().replace(/\s+/g, ' ')).filter(Boolean))];
    if (clean.length > 20 || clean.some((s) => s.length > 120)) throw new OrcoError('invalid', 'At most 20 sections of 120 characters');
    this.store.db.prepare("INSERT INTO org_settings (key, value) VALUES ('scope_sections', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value").run(JSON.stringify(clean));
    this.store.audit.record(actor, 'scope.template', { projectId: null, subject: 'org', detail: { sections: clean } });
    return this.sections();
  }

  /** Where a project stands, for anyone who can see it. */
  status(actor: Participant, projectName: string): ScopeStatus {
    return this.statusOf(this.store.visibleProject(actor, projectName).id);
  }

  statusOf(projectId: number): ScopeStatus {
    const row = this.store.db
      .prepare('SELECT p.scope_state, p.scope_version, p.scope_decision_id, u.name AS approver FROM projects p LEFT JOIN participants u ON u.id = p.scope_approved_by WHERE p.id = ?')
      .get(projectId) as { scope_state: ScopeState; scope_version: number | null; scope_decision_id: number | null; approver: string | null };
    const sections = this.sections();
    const text = this.text(projectId);
    return {
      state: row.scope_state,
      sections,
      missing: text === null ? sections : missingSections(text.content, sections),
      approvedVersion: row.scope_version,
      approvedBy: row.approver,
      decisionId: row.scope_decision_id,
      path: SCOPE_PATH,
      exists: text !== null,
    };
  }

  /** Writes the template as SCOPE.md, when the project has none yet. */
  start(actor: Participant, projectName: string): ScopeStatus {
    const project = this.store.writableProject(actor, projectName);
    if (this.text(project.id) === null) this.store.files.write(actor, projectName, SCOPE_PATH, scopeTemplate(projectName, this.sections()), { note: 'Scope template' });
    return this.statusOf(project.id);
  }

  /** An org or project admin approves the current SCOPE.md: every section must have content. */
  approve(actor: Participant, projectName: string, note = ''): ScopeStatus {
    if (actor.kind !== 'user') throw new OrcoError('forbidden', 'Only people approve a scope');
    const project = this.store.visibleProject(actor, projectName);
    if (!this.store.isOrgAdmin(actor) && this.store.roleIn(actor, project.id) !== 'admin') throw new OrcoError('forbidden', `Only admins of ${projectName} (or org admins in it) approve its scope`);
    const text = this.text(project.id);
    if (text === null) throw new OrcoError('conflict', `${projectName} has no ${SCOPE_PATH} yet`);
    const missing = missingSections(text.content, this.sections());
    if (missing.length) throw new OrcoError('conflict', `${SCOPE_PATH} has nothing under: ${missing.join('; ')}`);
    const decision = this.store.decisions.record(actor, {
      project: projectName,
      title: `Scope of ${projectName} approved (${SCOPE_PATH} v${text.version})`,
      decision: `The scope in ${SCOPE_PATH}, version ${text.version}, is approved. Build work may start; changing the scope needs approval again.${note.trim() ? `\n\n${note.trim()}` : ''}`,
      tags: ['scope'],
    });
    this.store.db
      .prepare("UPDATE projects SET scope_state = 'approved', scope_version = ?, scope_approved_by = ?, scope_decision_id = ? WHERE id = ?")
      .run(text.version, actor.id, decision.id, project.id);
    this.store.audit.record(actor, 'scope.approve', { projectId: project.id, subject: `project:${projectName}`, detail: { version: text.version, decisionId: decision.id } });
    this.store.events.emit('ticket', { projectId: project.id, ref: null });
    return this.statusOf(project.id);
  }

  /** Org admins take a project out of the gate (or put it in): for projects with nothing to build. */
  setGate(actor: Participant, projectName: string, on: boolean): ScopeStatus {
    if (actor.kind !== 'user' || !this.store.isOrgAdmin(actor)) throw new OrcoError('forbidden', 'Only org admins turn the scope gate on or off');
    const project = this.store.visibleProject(actor, projectName);
    const current = this.statusOf(project.id).state;
    const next: ScopeState = on ? (current === 'approved' ? 'approved' : 'scoping') : 'none';
    this.store.db.prepare('UPDATE projects SET scope_state = ? WHERE id = ?').run(next, project.id);
    this.store.audit.record(actor, 'scope.gate', { projectId: project.id, subject: `project:${projectName}`, detail: { on } });
    return this.statusOf(project.id);
  }

  /** Called after a project file is written: a changed SCOPE.md needs approval again. */
  onFileWritten(projectId: number, path: string, version: number): void {
    if (path !== SCOPE_PATH) return;
    const row = this.store.db.prepare('SELECT scope_state, scope_version FROM projects WHERE id = ?').get(projectId) as { scope_state: ScopeState; scope_version: number | null };
    if (row.scope_state === 'approved' && row.scope_version !== version) {
      this.store.db.prepare("UPDATE projects SET scope_state = 'scoping' WHERE id = ?").run(projectId);
      this.store.audit.record(null, 'scope.reopen', { projectId, subject: `file:${SCOPE_PATH}`, detail: { version } });
    }
  }

  /**
   * Refuses moving a build ticket past Backlog while its project is in Scope, saying what is missing.
   * Tickets labelled "scope" are the scoping work and are not held.
   */
  assertBuildAllowed(projectId: number, ticketLabels: string[], toCategory: string): void {
    if (toCategory === 'backlog' || toCategory === 'canceled') return;
    if (ticketLabels.some((l) => l.toLowerCase() === SCOPE_LABEL)) return;
    const status = this.statusOf(projectId);
    if (status.state !== 'scoping') return;
    throw new OrcoError('conflict', this.refusal(status));
  }

  /** A gated action (a repo, a stack, a deploy) in a project still in Scope is refused. */
  assertActionAllowed(projectId: number | null, text: string): void {
    if (projectId === null || !/\b(repo(sitor(y|ies))?|stack|deploy(s|ment|ing)?|provision|infrastructure|terraform|helm|docker compose)\b/i.test(text)) return;
    const status = this.statusOf(projectId);
    if (status.state !== 'scoping') return;
    throw new OrcoError('conflict', `${this.refusal(status)} No repos, stacks or deploys until then.`);
  }

  private refusal(status: ScopeStatus): string {
    return status.missing.length
      ? `Scope not approved: ${SCOPE_PATH} still needs ${status.missing.join('; ')}, then an admin's approval.`
      : `Scope not approved: ${SCOPE_PATH} is complete and waits for an admin to approve it.`;
  }

  private text(projectId: number): { content: string; version: number } | null {
    return (
      (this.store.db
        .prepare('SELECT v.content, v.version FROM files f JOIN file_versions v ON v.file_id = f.id WHERE f.project_id = ? AND f.path = ? ORDER BY v.version DESC LIMIT 1')
        .get(projectId, SCOPE_PATH) as { content: string; version: number } | undefined) ?? null
    );
  }
}
