import { OrcoError } from './errors.js';
import { type Participant, PROJECT_ROLES, type ProjectRole, type Store } from './store.js';

const NAME = /^[a-z0-9][a-z0-9-]{0,31}$/;

export interface Group {
  name: string;
  members: string[];
  projects: { project: string; role: ProjectRole }[];
}

interface Row {
  id: number;
  name: string;
}

/**
 * Groups of people, like @backend: add a group to many projects at once, with a role, and mention it
 * to ping everyone in it who can see the room. Org admins manage groups; project admins choose which
 * groups their project has.
 */
export class Groups {
  constructor(private readonly store: Store) {}

  create(actor: Participant, name: string, members: string[] = []): Group {
    this.orgAdmin(actor);
    if (!NAME.test(name)) throw new OrcoError('invalid', 'Group name must be 1-32 lowercase letters, digits or dashes');
    if (this.store.participantByName(name) || ['all', 'everyone', 'here'].includes(name)) throw new OrcoError('conflict', `The name ${name} is taken`);
    try {
      this.store.db.prepare('INSERT INTO groups (name) VALUES (?)').run(name);
    } catch {
      throw new OrcoError('conflict', `Group ${name} already exists`);
    }
    this.store.audit.record(actor, 'group.create', { subject: `group:${name}` });
    for (const member of members) this.addMember(actor, name, member);
    this.store.events.emit('structure');
    return this.get(name);
  }

  remove(actor: Participant, name: string): void {
    this.orgAdmin(actor);
    const group = this.row(name);
    this.store.db.prepare('DELETE FROM groups WHERE id = ?').run(group.id);
    this.store.audit.record(actor, 'group.delete', { subject: `group:${name}` });
    this.store.events.emit('structure');
  }

  addMember(actor: Participant, name: string, userName: string): Group {
    this.orgAdmin(actor);
    const group = this.row(name);
    const user = this.user(userName);
    this.store.db.prepare('INSERT OR IGNORE INTO group_members (group_id, user_id) VALUES (?, ?)').run(group.id, user.id);
    this.store.audit.record(actor, 'group.add_member', { subject: `group:${name}`, detail: { user: userName } });
    this.store.events.emit('structure');
    return this.get(name);
  }

  removeMember(actor: Participant, name: string, userName: string): Group {
    this.orgAdmin(actor);
    const group = this.row(name);
    const user = this.user(userName);
    this.store.db.prepare('DELETE FROM group_members WHERE group_id = ? AND user_id = ?').run(group.id, user.id);
    this.store.audit.record(actor, 'group.remove_member', { subject: `group:${name}`, detail: { user: userName } });
    this.store.events.emit('structure');
    return this.get(name);
  }

  /** Gives a group a role in a project (project admins), or takes it out with role null. */
  setProjectRole(actor: Participant, projectName: string, name: string, role: ProjectRole | null): Group {
    this.store.unscoped(actor, 'change project groups');
    const project = this.store.adminProject(actor, projectName);
    const group = this.row(name);
    if (role === null) {
      this.store.db.prepare('DELETE FROM project_groups WHERE project_id = ? AND group_id = ?').run(project.id, group.id);
    } else {
      if (!PROJECT_ROLES.includes(role)) throw new OrcoError('invalid', `role is ${PROJECT_ROLES.join(', ')}`);
      this.store.db
        .prepare('INSERT INTO project_groups (project_id, group_id, role) VALUES (?, ?, ?) ON CONFLICT (project_id, group_id) DO UPDATE SET role = excluded.role')
        .run(project.id, group.id, role);
    }
    this.store.audit.record(actor, 'project.group', { projectId: project.id, subject: `group:${name}`, detail: { role } });
    this.store.events.emit('structure');
    return this.get(name);
  }

  /**
   * Groups, for people: org admins see everything; others see each group's members but only the
   * projects they can see themselves. Agents and task tokens get none.
   */
  list(actor: Participant): Group[] {
    if (actor.kind !== 'user' || actor.scope) throw new OrcoError('forbidden', 'Only people see groups');
    const all = (this.store.db.prepare('SELECT name FROM groups ORDER BY name').all() as { name: string }[]).map((g) => this.get(g.name));
    if (this.store.isOrgAdmin(actor)) return all;
    const visible = new Set(this.store.listProjects(actor).map((p) => p.name));
    return all.map((g) => ({ ...g, projects: g.projects.filter((p) => visible.has(p.project)) }));
  }

  get(name: string): Group {
    const group = this.row(name);
    const members = (this.store.db
      .prepare('SELECT p.name FROM group_members gm JOIN participants p ON p.id = gm.user_id WHERE gm.group_id = ? ORDER BY p.name')
      .all(group.id) as { name: string }[]).map((m) => m.name);
    const projects = this.store.db
      .prepare('SELECT p.name AS project, pg.role FROM project_groups pg JOIN projects p ON p.id = pg.project_id WHERE pg.group_id = ? ORDER BY p.name')
      .all(group.id) as { project: string; role: ProjectRole }[];
    return { name: group.name, members, projects };
  }

  /** People in a group, for @mentions; empty if there is no such group. */
  membersOf(name: string): Participant[] {
    return (this.store.db
      .prepare("SELECT p.id, p.name FROM groups g JOIN group_members gm ON gm.group_id = g.id JOIN participants p ON p.id = gm.user_id WHERE g.name = ? AND p.kind = 'user'")
      .all(name) as { id: number; name: string }[]).map((p) => ({ id: p.id, kind: 'user', name: p.name, ownerId: null }));
  }

  private orgAdmin(actor: Participant): void {
    if (!this.store.isOrgAdmin(actor)) throw new OrcoError('forbidden', 'Only org admins manage groups');
  }

  private row(name: string): Row {
    const row = this.store.db.prepare('SELECT id, name FROM groups WHERE name = ?').get(name) as Row | undefined;
    if (!row) throw new OrcoError('not_found', `No group ${name}`);
    return row;
  }

  private user(name: string): Participant {
    const user = this.store.participantByName(name);
    if (!user || user.kind !== 'user') throw new OrcoError('not_found', `No user named ${name}`);
    return user;
  }
}
