import { OrcoError } from './errors.js';
import type { Participant, Store } from './store.js';

/*
 * The admin digest (#115): what agents and people did with their permissions over a period, built
 * from the audit log, for the org (org admins) or one project (its admins). Deploys and pushes
 * approved and by whom (and any outside a window or during a freeze), standing approvals granted and
 * used, checked rules hit and overrides with their reasons, secrets requested and used (names only),
 * new members and agents, token rotations, pauses and budget alerts. Every line carries its audit
 * entry id. Written each Monday with the weekly digests, and readable for any date range.
 */

const DEPLOY = /\b(deploy(s|ing|ment)?|push(es|ing)?|release|ship(ping)?|roll ?out)\b/i;

export interface DigestLine {
  auditId: number;
  at: string;
  project: string | null;
  text: string;
}

export interface AdminDigest {
  from: string;
  to: string;
  project: string | null;
  sections: { title: string; lines: DigestLine[] }[];
  markdown: string;
}

interface Row {
  id: number;
  at: string;
  action: string;
  actor: string | null;
  actor_owner: string | null;
  project: string | null;
  subject: string | null;
  detail: string | null;
}

export function adminDigest(store: Store, actor: Participant, input: { from: string; to: string; project?: string | null }): AdminDigest {
  if (actor.kind !== 'user') throw new OrcoError('forbidden', 'Only people read the admin digest');
  const from = new Date(Date.parse(input.from));
  const to = new Date(Date.parse(input.to));
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || to <= from) throw new OrcoError('invalid', 'from and to are dates, to after from');
  let projectId: number | null = null;
  if (input.project) {
    const p = store.visibleProject(actor, input.project);
    if (store.roleIn(actor, p.id) !== 'admin' && !store.isOrgAdmin(actor)) throw new OrcoError('forbidden', `Only admins of ${input.project} read its admin digest`);
    projectId = p.id;
  } else if (!store.isOrgAdmin(actor)) {
    throw new OrcoError('forbidden', 'Only org admins read the org-wide digest; name a project you administer');
  }
  const rows = store.db
    .prepare(
      `SELECT au.id, au.at, au.action, a.name AS actor, o.name AS actor_owner, p.name AS project, au.subject, au.detail
       FROM audit au LEFT JOIN participants a ON a.id = au.actor_id LEFT JOIN participants o ON o.id = a.owner_id LEFT JOIN projects p ON p.id = au.project_id
       WHERE au.at >= ? AND au.at < ? ${projectId === null ? '' : 'AND au.project_id = ?'} ORDER BY au.id`,
    )
    .all(...[from.toISOString(), to.toISOString(), ...(projectId === null ? [] : [projectId])]) as unknown as Row[];

  const who = (r: Row) => (r.actor ? (r.actor_owner ? `${r.actor} (agent of ${r.actor_owner})` : r.actor) : 'Orco');
  const detail = (r: Row) => (r.detail ? (JSON.parse(r.detail) as Record<string, unknown>) : {});
  const approval = (subject: string | null) => {
    const id = Number(/^approval:(\d+)$/.exec(subject ?? '')?.[1]);
    if (!id) return null;
    return store.db
      .prepare("SELECT ap.summary, ap.action_kind, ap.warning, rq.name AS requester, tp.ticket_key || '-' || tk.number AS ticket FROM approvals ap JOIN participants rq ON rq.id = ap.requester_id LEFT JOIN tickets tk ON tk.id = ap.ticket_id LEFT JOIN projects tp ON tp.id = tk.project_id WHERE ap.id = ?")
      .get(id) as { summary: string; action_kind: string | null; warning: string | null; requester: string; ticket: string | null } | undefined;
  };
  const line = (r: Row, text: string): DigestLine => ({ auditId: r.id, at: r.at, project: r.project, text });

  const deploys: DigestLine[] = [];
  const standing: DigestLine[] = [];
  const rules: DigestLine[] = [];
  const secrets: DigestLine[] = [];
  const people: DigestLine[] = [];
  const tokens: DigestLine[] = [];
  const pauses: DigestLine[] = [];
  for (const r of rows) {
    const d = detail(r);
    switch (r.action) {
      case 'approval.decide': {
        if (d.decision !== 'approved') break;
        const a = approval(r.subject);
        if (!a) break;
        if (d.standing) standing.push(line(r, `${who(r)} said "don't ask again" for ${a.action_kind ?? 'this kind'}${a.ticket ? ` on ${a.ticket}` : ''}, for ${a.requester}`));
        if (DEPLOY.test(`${a.action_kind ?? ''} ${a.summary}`)) {
          deploys.push(line(r, `${who(r)} approved ${a.requester}'s "${a.summary}"${a.ticket ? ` (${a.ticket})` : ''}${a.warning ? `. ⚠ ${a.warning}` : ''}`));
        }
        break;
      }
      case 'approval.auto': {
        const a = approval(r.subject);
        standing.push(line(r, `Used a standing approval: ${a ? `${a.requester}'s "${a.summary}"${a.ticket ? ` (${a.ticket})` : ''}` : r.subject}`));
        break;
      }
      case 'checked_rule.block':
      case 'checked_rule.flag':
        rules.push(line(r, `${r.action === 'checked_rule.block' ? 'Blocked' : 'Flagged'} ${who(r)} by the rule ${(r.subject ?? '').replace(/^rule:/, '')}`));
        break;
      case 'freeze.override':
      case 'deploy_window.override':
      case 'ticket.done_override':
        rules.push(line(r, `${who(r)} overrode ${r.action === 'freeze.override' ? 'a freeze' : r.action === 'deploy_window.override' ? 'a deploy window' : `the Definition of Done on ${(r.subject ?? '').replace(/^ticket:/, '')}`}: ${String(d.reason ?? '')}`));
        break;
      case 'secret.request':
      case 'secret.use':
        secrets.push(line(r, `${who(r)} ${r.action === 'secret.use' ? 'used' : 'asked for'} ${(r.subject ?? '').replace(/^secret:/, '')}`));
        break;
      case 'user.create':
      case 'agent.create':
      case 'project.group':
      case 'project.remove_member':
      case 'group.add_member':
        people.push(line(r, `${who(r)}: ${r.action.replace('.', ' ').replace('_', ' ')} ${(r.subject ?? '').replace(/^[a-z]+:/, '')}`));
        break;
      case 'token.rotate':
        tokens.push(line(r, `${who(r)} rotated the token of ${(r.subject ?? '').replace(/^[a-z]+:/, '')}`));
        break;
      case 'pause.on':
      case 'pause.off':
      case 'budget.alert':
      case 'freeze.start':
        pauses.push(line(r, r.action === 'budget.alert' ? `Budget alert: ${(r.subject ?? '').replace(/^[a-z]+:/, '')} at ${String(d.level)}%` : `${who(r)}: ${r.action.replace('.', ' ')} ${(r.subject ?? '').replace(/^[a-z]+:/, '')}${d.reason ? ` (${String(d.reason)})` : ''}`));
        break;
    }
  }
  const sections = [
    { title: 'Deploys and pushes approved', lines: deploys },
    { title: 'Standing approvals granted and used', lines: standing },
    { title: 'Checked rules and overrides', lines: rules },
    { title: 'Secrets requested and used', lines: secrets },
    { title: 'Members and agents', lines: people },
    { title: 'Tokens rotated', lines: tokens },
    { title: 'Pauses, freezes and budget alerts', lines: pauses },
  ];
  const scope = projectId === null ? 'every project' : input.project!;
  const markdown = [
    `**Admin digest · ${scope} · ${from.toISOString().slice(0, 10)} to ${to.toISOString().slice(0, 10)}**`,
    ...sections.flatMap((s) => ['', `**${s.title} (${s.lines.length})**`, ...(s.lines.length ? s.lines.slice(0, 50).map((l) => `- ${l.at.slice(0, 16).replace('T', ' ')}${l.project ? ` · ${l.project}` : ''} · ${l.text} (audit #${l.auditId})`) : ['- None.'])]),
  ].join('\n');
  return { from: from.toISOString(), to: to.toISOString(), project: projectId === null ? null : input.project!, sections, markdown };
}
