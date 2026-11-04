import { OrcoError } from './errors.js';
import { readFileSync } from 'node:fs';
import { parseWindow } from './windows.js';
import { MODES, type Mode } from './modes.js';
import type { Participant, Store } from './store.js';

/*
 * Policies as a file (#120). ORCO_POLICY_FILE names a JSON file, kept in git and reviewed like code,
 * that sets the org's and each project's guard rails: the scope gate (#108), build order (#109),
 * Definition of Done checklists (#110), area owners (#111), deploy windows (#112), checked rules
 * (#113), permission modes (#119) and guest links (#117). It sets defaults, and "lock" names the
 * settings the app may no longer change ("managed by policy"). A project can only tighten the org:
 * a narrower mode cap, more rules. `orco policy check` validates a file; the server applies it on
 * start and on `orco policy reload`; `orco policy show` prints what is in force and where it came from.
 */

export const POLICY_VERSION = 1;
const LOCKABLE = ['scopeGate', 'scopeSections', 'modeCap', 'guestLinks', 'defaultMode'] as const;
type Lockable = (typeof LOCKABLE)[number];

interface ProjectPolicy {
  defaultMode?: Mode;
  modeCap?: Mode;
  orderRules?: { label: string; waitsMilestone?: string; waitsLabel?: string }[];
  checklists?: { label: string; items: { text: string; required?: boolean }[] }[];
  owners?: { kind: 'folder' | 'label'; area: string; owner: string }[];
  deployWindows?: { spec: string; mode?: 'allow' | 'deny'; refuse?: boolean }[];
  lock?: Lockable[];
}

export interface PolicyFile {
  version: number;
  org?: ProjectPolicy & {
    scopeGate?: boolean;
    scopeSections?: string[];
    guestLinks?: boolean;
    checkedRules?: { name: string; pattern?: string; regex?: boolean; scopes?: string[]; enabled?: boolean; owner?: string; why?: string }[];
  };
  projects?: Record<string, ProjectPolicy>;
}

const rank = (m: Mode) => MODES.indexOf(m);

/** Reads and checks a policy file: the errors, or what it will do, one line each. */
export function checkPolicy(text: string): { ok: boolean; errors: string[]; summary: string[]; policy: PolicyFile | null } {
  const errors: string[] = [];
  let policy: PolicyFile;
  try {
    policy = JSON.parse(text) as PolicyFile;
  } catch (err) {
    return { ok: false, errors: [`Not JSON: ${(err as Error).message}`], summary: [], policy: null };
  }
  const summary: string[] = [];
  if (policy.version !== POLICY_VERSION) errors.push(`version must be ${POLICY_VERSION}`);
  const known = new Set(['version', 'org', 'projects']);
  for (const key of Object.keys(policy)) if (!known.has(key)) errors.push(`Unknown key "${key}" at the top`);
  const mode = (where: string, value: unknown) => {
    if (value !== undefined && !(MODES as readonly string[]).includes(value as string)) errors.push(`${where}: a mode is one of ${MODES.join(', ')}`);
  };
  const part = (where: string, p: ProjectPolicy & Record<string, unknown>, org: boolean) => {
    const keys = new Set(['defaultMode', 'modeCap', 'orderRules', 'checklists', 'owners', 'deployWindows', 'lock', ...(org ? ['scopeGate', 'scopeSections', 'guestLinks', 'checkedRules'] : [])]);
    for (const key of Object.keys(p)) if (!keys.has(key)) errors.push(`${where}: unknown key "${key}"`);
    mode(`${where}.defaultMode`, p.defaultMode);
    mode(`${where}.modeCap`, p.modeCap);
    if (p.defaultMode && p.modeCap && rank(p.defaultMode) > rank(p.modeCap)) errors.push(`${where}: defaultMode ${p.defaultMode} is broader than modeCap ${p.modeCap}`);
    for (const [i, r] of (p.orderRules ?? []).entries()) {
      if (!r.label || (!r.waitsMilestone === !r.waitsLabel)) errors.push(`${where}.orderRules[${i}]: a label, and waitsMilestone or waitsLabel (one of them)`);
      else summary.push(`${where}: "${r.label}" waits for ${r.waitsMilestone ? `milestone ${r.waitsMilestone}` : `the "${r.waitsLabel}" tickets`}`);
    }
    for (const [i, c] of (p.checklists ?? []).entries()) {
      if (!c.label || !Array.isArray(c.items) || !c.items.length || c.items.some((it) => !it.text)) errors.push(`${where}.checklists[${i}]: a label and items with text`);
      else summary.push(`${where}: label "${c.label}" adds ${c.items.length} Done item(s), ${c.items.filter((it) => it.required !== false).length} required`);
    }
    for (const [i, o] of (p.owners ?? []).entries()) {
      if (org) errors.push(`${where}.owners: owners belong to a project`);
      else if ((o.kind !== 'folder' && o.kind !== 'label') || !o.area || !o.owner) errors.push(`${where}.owners[${i}]: kind folder or label, an area and an owner`);
      else summary.push(`${where}: ${o.kind} ${o.area} is owned by ${o.owner}`);
    }
    for (const [i, w] of (p.deployWindows ?? []).entries()) {
      try {
        parseWindow(w.spec);
        summary.push(`${where}: ${w.mode === 'deny' ? 'no deploys' : 'deploys only'} ${w.spec}${w.refuse ? (w.mode === 'deny' ? ', refused then' : ', refused outside') : ''}`);
      } catch (err) {
        errors.push(`${where}.deployWindows[${i}]: ${(err as Error).message}`);
      }
    }
    for (const key of p.lock ?? []) if (!(LOCKABLE as readonly string[]).includes(key)) errors.push(`${where}.lock: "${key}" cannot be locked; lockable: ${LOCKABLE.join(', ')}`);
    if (p.modeCap) summary.push(`${where}: modes capped at ${p.modeCap}`);
    if (p.defaultMode) summary.push(`${where}: new tickets start ${p.defaultMode}`);
  };
  if (policy.org) {
    part('org', policy.org as ProjectPolicy & Record<string, unknown>, true);
    if (policy.org.scopeGate !== undefined) summary.push(`org: new projects ${policy.org.scopeGate ? 'start in Scope' : 'skip the scope gate'}`);
    if (policy.org.guestLinks !== undefined) summary.push(`org: guest links ${policy.org.guestLinks ? 'on' : 'off'}`);
    for (const [i, r] of (policy.org.checkedRules ?? []).entries()) {
      if (!r.name) errors.push(`org.checkedRules[${i}]: a name`);
      else if (r.pattern && r.regex) {
        try {
          new RegExp(r.pattern);
        } catch {
          errors.push(`org.checkedRules[${i}]: the pattern is not a regular expression`);
        }
      }
      if (r.name) summary.push(`org: checked rule "${r.name}" ${r.enabled === false ? 'off' : 'on'}`);
    }
  }
  for (const [name, p] of Object.entries(policy.projects ?? {})) {
    part(`projects.${name}`, p as ProjectPolicy & Record<string, unknown>, false);
    // A project only tightens the org.
    const orgCap = policy.org?.modeCap;
    if (orgCap && p.modeCap && rank(p.modeCap) > rank(orgCap)) errors.push(`projects.${name}.modeCap ${p.modeCap} is broader than the org's ${orgCap}: a project can only tighten`);
    if (orgCap && p.defaultMode && rank(p.defaultMode) > rank(orgCap)) errors.push(`projects.${name}.defaultMode ${p.defaultMode} is broader than the org's cap ${orgCap}`);
  }
  return { ok: errors.length === 0, errors, summary, policy: errors.length ? null : policy };
}

export class PolicyFiles {
  /** Settings the file locks: "org.modeCap", "shop.defaultMode". */
  private locked = new Set<string>();
  private sources = new Map<string, string>();
  loadedFrom: string | null = null;
  loadedAt: string | null = null;

  constructor(private readonly store: Store) {}

  isLocked(scope: string, key: Lockable): boolean {
    return this.locked.has(`${scope}.${key}`);
  }

  /** Refuses an app change to a setting the file manages. */
  assertUnlocked(scope: string, key: Lockable): void {
    if (this.isLocked(scope, key)) throw new OrcoError('forbidden', `${key === 'modeCap' ? 'The mode cap' : key} is managed by the policy file (${this.loadedFrom}); change it there`);
  }

  /** Reads ORCO_POLICY_FILE (or the path given) and applies it. Returns the check's errors, if any. */
  load(path = process.env.ORCO_POLICY_FILE): string[] {
    if (!path) return [];
    const result = checkPolicy(readFileSync(path, 'utf8'));
    if (!result.ok) return result.errors;
    this.apply(result.policy!);
    this.loadedFrom = path;
    this.loadedAt = new Date(this.store.now()).toISOString();
    this.store.audit.record(null, 'policy.load', { detail: { path, summary: result.summary } });
    return [];
  }

  apply(policy: PolicyFile): void {
    const db = this.store.db;
    const system = this.store.system();
    this.locked.clear();
    this.sources.clear();
    const setting = (key: string, value: string) => db.prepare('INSERT INTO org_settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value').run(key, value);
    const org = policy.org ?? {};
    for (const key of org.lock ?? []) this.locked.add(`org.${key}`);
    if (org.scopeGate !== undefined) (setting('scope_gate_new_projects', org.scopeGate ? 'on' : 'off'), this.sources.set('org.scopeGate', 'file'));
    if (org.scopeSections) (setting('scope_sections', JSON.stringify(org.scopeSections)), this.sources.set('org.scopeSections', 'file'));
    if (org.guestLinks !== undefined) (setting('guest_links', org.guestLinks ? 'on' : 'off'), this.sources.set('org.guestLinks', 'file'));
    if (org.modeCap) (setting('mode_cap', JSON.stringify({ mode: org.modeCap, by: 'the policy file' })), this.sources.set('org.modeCap', 'file'));
    for (const r of org.checkedRules ?? []) {
      const existing = db.prepare('SELECT id FROM checked_rules WHERE name = ?').get(r.name) as { id: number } | undefined;
      const owner = r.owner ? (this.store.participantByName(r.owner)?.id ?? null) : null;
      if (existing) {
        db.prepare('UPDATE checked_rules SET enabled = ?, pattern = coalesce(?, pattern), regex = coalesce(?, regex), scopes = coalesce(?, scopes), owner_id = coalesce(?, owner_id), why = coalesce(?, why) WHERE id = ?').run(
          r.enabled === false ? 0 : 1, r.pattern ?? null, r.regex === undefined ? null : r.regex ? 1 : 0, r.scopes?.join(',') ?? null, owner, r.why ?? null, existing.id,
        );
      } else if (r.pattern) {
        db.prepare('INSERT INTO checked_rules (name, pattern, regex, scopes, enabled, owner_id, why) VALUES (?, ?, ?, ?, ?, ?, ?)').run(r.name, r.pattern, r.regex ? 1 : 0, (r.scopes ?? ['approval']).join(','), r.enabled === false ? 0 : 1, owner, r.why ?? '');
      }
      this.sources.set(`org.checkedRule.${r.name}`, 'file');
    }
    const author = system?.id ?? null;
    const projectPart = (projectId: number | null, scope: string, p: ProjectPolicy) => {
      for (const key of p.lock ?? []) this.locked.add(`${scope}.${key}`);
      if (projectId !== null && p.defaultMode) (db.prepare('UPDATE projects SET default_mode = ? WHERE id = ?').run(p.defaultMode, projectId), this.sources.set(`${scope}.defaultMode`, 'file'));
      if (projectId !== null && p.modeCap) (db.prepare('UPDATE projects SET mode_cap = ?, mode_cap_by = ? WHERE id = ?').run(p.modeCap, author, projectId), this.sources.set(`${scope}.modeCap`, 'file'));
      for (const r of p.orderRules ?? []) {
        const label = r.label.toLowerCase();
        const has = db.prepare('SELECT 1 FROM order_rules WHERE project_id IS ? AND label = ? AND waits_milestone IS ? AND waits_label IS ?').get(projectId, label, r.waitsMilestone ?? null, r.waitsLabel?.toLowerCase() ?? null);
        if (!has && author !== null) db.prepare('INSERT INTO order_rules (project_id, label, waits_milestone, waits_label, created_by) VALUES (?, ?, ?, ?, ?)').run(projectId, label, r.waitsMilestone ?? null, r.waitsLabel?.toLowerCase() ?? null, author);
      }
      for (const c of p.checklists ?? []) {
        db.prepare('DELETE FROM checklist_templates WHERE project_id IS ? AND label = ?').run(projectId, c.label.toLowerCase());
        db.prepare('INSERT INTO checklist_templates (project_id, label, items, created_by) VALUES (?, ?, ?, ?)').run(projectId, c.label.toLowerCase(), JSON.stringify(c.items.map((it) => ({ text: it.text, required: it.required !== false }))), author);
      }
      for (const w of p.deployWindows ?? []) {
        const has = db.prepare('SELECT 1 FROM deploy_windows WHERE project_id IS ? AND spec = ? AND mode = ?').get(projectId, w.spec, w.mode ?? 'allow');
        if (!has && author !== null) db.prepare('INSERT INTO deploy_windows (project_id, spec, mode, refuse, created_by) VALUES (?, ?, ?, ?, ?)').run(projectId, w.spec, w.mode ?? 'allow', w.refuse ? 1 : 0, author);
      }
      if (projectId !== null) {
        for (const o of p.owners ?? []) {
          const user = this.store.participantByName(o.owner);
          if (user) db.prepare('INSERT OR IGNORE INTO area_owners (project_id, kind, area, user_id) VALUES (?, ?, ?, ?)').run(projectId, o.kind, o.kind === 'label' ? o.area.toLowerCase() : o.area, user.id);
        }
      }
    };
    projectPart(null, 'org', org);
    for (const [name, p] of Object.entries(policy.projects ?? {})) {
      const row = db.prepare('SELECT id FROM projects WHERE name = ?').get(name) as { id: number } | undefined;
      if (row) projectPart(row.id, name, p);
    }
  }

  /** What is in force, and where each value came from: the file, the app, or the default. Org admins. */
  show(actor: Participant): { file: string | null; loadedAt: string | null; settings: { key: string; value: unknown; source: 'file' | 'app' | 'default'; locked: boolean }[] } {
    if (actor.kind !== 'user' || !this.store.isOrgAdmin(actor)) throw new OrcoError('forbidden', 'Only org admins read the policy in force');
    const settings: { key: string; value: unknown; source: 'file' | 'app' | 'default'; locked: boolean }[] = [];
    const org = (key: string, name: string, fallback: unknown) => {
      const row = this.store.db.prepare('SELECT value FROM org_settings WHERE key = ?').get(key) as { value: string } | undefined;
      settings.push({ key: `org.${name}`, value: row ? row.value : fallback, source: this.sources.get(`org.${name}`) === 'file' ? 'file' : row ? 'app' : 'default', locked: this.locked.has(`org.${name}`) });
    };
    org('scope_gate_new_projects', 'scopeGate', 'on');
    org('scope_sections', 'scopeSections', '(built in)');
    org('guest_links', 'guestLinks', 'on');
    org('mode_cap', 'modeCap', 'none');
    for (const p of this.store.db.prepare('SELECT name, default_mode, mode_cap FROM projects ORDER BY name').all() as { name: string; default_mode: string; mode_cap: string | null }[]) {
      settings.push({ key: `${p.name}.defaultMode`, value: p.default_mode, source: this.sources.has(`${p.name}.defaultMode`) ? 'file' : p.default_mode === 'supervised' ? 'default' : 'app', locked: this.locked.has(`${p.name}.defaultMode`) });
      settings.push({ key: `${p.name}.modeCap`, value: p.mode_cap ?? 'none', source: this.sources.has(`${p.name}.modeCap`) ? 'file' : p.mode_cap ? 'app' : 'default', locked: this.locked.has(`${p.name}.modeCap`) });
    }
    return { file: this.loadedFrom, loadedAt: this.loadedAt, settings };
  }

  lockedKeys(): string[] {
    return [...this.locked];
  }
}
