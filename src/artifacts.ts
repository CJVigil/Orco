import { OrcoError } from './errors.js';
import type { Participant, Store } from './store.js';

/*
 * Shared artifacts (#99): a versioned page (HTML, Markdown or a chart) that a person or an agent
 * publishes into a project, optionally on a ticket. HTML and charts are served from
 * /api/artifacts/:id/render with a CSP sandbox (scripts, but no same-origin, no network), and the
 * web app frames them with sandbox="allow-scripts", so a page can never read Orco's cookies or call
 * its API. Access follows the project, and the ticket's when it is private.
 */

export const ARTIFACT_KINDS = ['html', 'markdown', 'chart'] as const;
export type ArtifactKind = (typeof ARTIFACT_KINDS)[number];
export const MAX_ARTIFACT_BYTES = 2 * 1024 * 1024;
const MAX_TITLE = 120;
const MAX_DESCRIPTION = 200;
const MAX_VERSIONS = 50;

export interface ArtifactVersion {
  version: number;
  by: string;
  at: string;
  size: number;
}

export interface Artifact {
  id: number;
  project: string;
  ticket: string | null;
  title: string;
  description: string;
  kind: ArtifactKind;
  version: number;
  by: string;
  updatedAt: string;
  createdAt: string;
  versions: ArtifactVersion[];
}

interface Row {
  id: number;
  project_id: number;
  project: string;
  ticket_id: number | null;
  ticket_ref: string | null;
  title: string;
  description: string;
  kind: ArtifactKind;
  created_at: string;
  updated_at: string;
}

const SELECT = `SELECT a.id, a.project_id, p.name AS project, a.ticket_id,
    CASE WHEN a.ticket_id IS NULL THEN NULL ELSE tp.ticket_key || '-' || t.number END AS ticket_ref,
    a.title, a.description, a.kind, a.created_at, a.updated_at
  FROM artifacts a JOIN projects p ON p.id = a.project_id
  LEFT JOIN tickets t ON t.id = a.ticket_id LEFT JOIN projects tp ON tp.id = t.project_id`;

export class Artifacts {
  constructor(private readonly store: Store) {}

  /**
   * Publishes a new artifact, or (with id) a new version of one. Content is stored as given; it is
   * only ever shown sandboxed. A chart is JSON: { type: "bar" | "line", labels: [...], series: [{ name, values }] }.
   */
  publish(
    actor: Participant,
    input: { id?: number; project?: string; title?: string; description?: string; content: string; kind?: ArtifactKind; ticket?: string | null },
  ): Artifact {
    const content = input.content ?? '';
    if (!content.trim()) throw new OrcoError('invalid', 'The artifact is empty');
    if (Buffer.byteLength(content) > MAX_ARTIFACT_BYTES) throw new OrcoError('invalid', `An artifact can be at most ${MAX_ARTIFACT_BYTES / 1024 / 1024} MB`);
    const now = new Date(this.store.now()).toISOString();
    let id: number;
    if (input.id !== undefined) {
      const row = this.row(actor, input.id);
      this.store.assertWrite(actor, row.project_id);
      const kind = input.kind ?? row.kind;
      this.checkKind(kind, content);
      this.store.checkRate(actor, 'post');
      const last = this.versionCount(row.id);
      if (last >= MAX_VERSIONS) this.store.db.prepare('DELETE FROM artifact_versions WHERE artifact_id = ? AND version = (SELECT min(version) FROM artifact_versions WHERE artifact_id = ?)').run(row.id, row.id);
      this.store.db
        .prepare('UPDATE artifacts SET title = ?, description = ?, kind = ?, updated_at = ? WHERE id = ?')
        .run(this.title(input.title ?? row.title), this.description(input.description ?? row.description), kind, now, row.id);
      this.addVersion(row.id, actor, content, now);
      id = row.id;
      this.store.audit.record(actor, 'artifact.publish', { projectId: row.project_id, subject: `artifact:${row.id}`, detail: { version: this.latest(row.id) } });
    } else {
      if (!input.project && !input.ticket) throw new OrcoError('invalid', 'Say which project (or ticket) the artifact belongs to');
      let projectId: number;
      let ticketId: number | null = null;
      if (input.ticket) {
        ticketId = this.store.tickets.idOf(actor, input.ticket);
        projectId = (this.store.db.prepare('SELECT project_id FROM tickets WHERE id = ?').get(ticketId) as { project_id: number }).project_id;
      } else projectId = this.store.visibleProject(actor, input.project!).id;
      this.store.assertWrite(actor, projectId);
      const kind = input.kind ?? 'html';
      this.checkKind(kind, content);
      this.store.checkRate(actor, 'post');
      const { lastInsertRowid } = this.store.db
        .prepare('INSERT INTO artifacts (project_id, ticket_id, title, description, kind, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .run(projectId, ticketId, this.title(input.title ?? ''), this.description(input.description ?? ''), kind, actor.id, now, now);
      id = Number(lastInsertRowid);
      this.addVersion(id, actor, content, now);
      this.store.audit.record(actor, 'artifact.publish', { projectId, subject: `artifact:${id}`, detail: { version: 1 } });
    }
    const artifact = this.get(actor, id);
    this.store.events.emit('artifact', { projectId: this.row(actor, id).project_id, id });
    return artifact;
  }

  list(actor: Participant, filter: { project?: string; ticket?: string } = {}): Artifact[] {
    let rows: Row[];
    if (filter.ticket) {
      const ticketId = this.store.tickets.idOf(actor, filter.ticket);
      rows = this.store.db.prepare(`${SELECT} WHERE a.ticket_id = ? ORDER BY a.updated_at DESC`).all(ticketId) as unknown as Row[];
    } else if (filter.project) {
      const project = this.store.visibleProject(actor, filter.project);
      rows = this.store.db.prepare(`${SELECT} WHERE a.project_id = ? ORDER BY a.updated_at DESC`).all(project.id) as unknown as Row[];
    } else {
      const visible = this.store.projectFilter(actor, 'a.project_id');
      rows = this.store.db.prepare(`${SELECT} WHERE ${visible.sql} ORDER BY a.updated_at DESC LIMIT 200`).all(...visible.params) as unknown as Row[];
    }
    return rows.filter((r) => r.ticket_id === null || this.store.tickets.sees(actor, r.ticket_id)).map((r) => this.toArtifact(r));
  }

  /** The artifacts on a ticket the caller has already checked. */
  forTicket(ticketId: number): Artifact[] {
    return (this.store.db.prepare(`${SELECT} WHERE a.ticket_id = ? ORDER BY a.updated_at DESC`).all(ticketId) as unknown as Row[]).map((r) => this.toArtifact(r));
  }

  get(actor: Participant, id: number): Artifact {
    return this.toArtifact(this.row(actor, id));
  }

  /** One version's content (the latest by default). */
  content(actor: Participant, id: number, version?: number): { artifact: Artifact; version: number; content: string } {
    const artifact = this.get(actor, id);
    const v = version ?? artifact.version;
    const row = this.store.db.prepare('SELECT content FROM artifact_versions WHERE artifact_id = ? AND version = ?').get(id, v) as { content: string } | undefined;
    if (!row) throw new OrcoError('not_found', `Artifact ${id} has no version ${v}`);
    return { artifact, version: v, content: row.content };
  }

  /** Deletes an artifact and its versions: whoever published it first, or a project admin. People only. */
  remove(actor: Participant, id: number): void {
    const row = this.row(actor, id);
    const creator = (this.store.db.prepare('SELECT created_by FROM artifacts WHERE id = ?').get(id) as { created_by: number }).created_by;
    if (actor.kind !== 'user' || (creator !== actor.id && this.store.roleIn(actor, row.project_id) !== 'admin')) {
      throw new OrcoError('forbidden', 'Only the person who published it or a project admin deletes an artifact');
    }
    this.store.db.prepare('DELETE FROM artifacts WHERE id = ?').run(id);
    this.store.audit.record(actor, 'artifact.delete', { projectId: row.project_id, subject: `artifact:${id}`, detail: { title: row.title } });
    this.store.events.emit('artifact', { projectId: row.project_id, id });
  }

  private row(actor: Participant, id: number): Row {
    const row = this.store.db.prepare(`${SELECT} WHERE a.id = ?`).get(id) as Row | undefined;
    if (!row || !this.store.canSee(actor, row.project_id) || (row.ticket_id !== null && !this.store.tickets.sees(actor, row.ticket_id))) {
      throw new OrcoError('not_found', `No artifact ${id}`);
    }
    return row;
  }

  private toArtifact(row: Row): Artifact {
    const versions = (
      this.store.db
        .prepare('SELECT v.version, p.name AS by, v.created_at AS at, length(CAST(v.content AS BLOB)) AS size FROM artifact_versions v JOIN participants p ON p.id = v.published_by WHERE v.artifact_id = ? ORDER BY v.version DESC')
        .all(row.id) as unknown as ArtifactVersion[]
    ).map((v) => ({ version: v.version, by: v.by, at: v.at, size: v.size }));
    return {
      id: row.id,
      project: row.project,
      ticket: row.ticket_ref,
      title: row.title,
      description: row.description,
      kind: row.kind,
      version: versions[0]?.version ?? 0,
      by: versions[0]?.by ?? '',
      updatedAt: row.updated_at,
      createdAt: row.created_at,
      versions,
    };
  }

  private addVersion(id: number, actor: Participant, content: string, at: string): void {
    const next = this.latest(id) + 1;
    this.store.db.prepare('INSERT INTO artifact_versions (artifact_id, version, content, published_by, created_at) VALUES (?, ?, ?, ?, ?)').run(id, next, content, actor.id, at);
  }

  private latest(id: number): number {
    return (this.store.db.prepare('SELECT coalesce(max(version), 0) AS v FROM artifact_versions WHERE artifact_id = ?').get(id) as { v: number }).v;
  }

  private versionCount(id: number): number {
    return (this.store.db.prepare('SELECT count(*) AS n FROM artifact_versions WHERE artifact_id = ?').get(id) as { n: number }).n;
  }

  private checkKind(kind: string, content: string): void {
    if (!ARTIFACT_KINDS.includes(kind as ArtifactKind)) throw new OrcoError('invalid', `kind is ${ARTIFACT_KINDS.join(', ')}`);
    if (kind === 'chart') parseChart(content);
  }

  private title(raw: string): string {
    const title = raw.trim().replace(/\s+/g, ' ');
    if (!title) throw new OrcoError('invalid', 'An artifact needs a title');
    if (title.length > MAX_TITLE) throw new OrcoError('invalid', `A title can be at most ${MAX_TITLE} characters`);
    return title;
  }

  private description(raw: string): string {
    const d = raw.trim().replace(/\s+/g, ' ');
    if (d.length > MAX_DESCRIPTION) throw new OrcoError('invalid', `A description is one line, at most ${MAX_DESCRIPTION} characters`);
    return d;
  }
}

interface Chart {
  type: 'bar' | 'line';
  title?: string;
  labels: string[];
  series: { name: string; values: number[] }[];
}

export function parseChart(content: string): Chart {
  let chart: Chart;
  try {
    chart = JSON.parse(content) as Chart;
  } catch {
    throw new OrcoError('invalid', 'A chart is JSON: { "type": "bar" | "line", "labels": [...], "series": [{ "name": "...", "values": [...] }] }');
  }
  const ok =
    chart &&
    (chart.type === 'bar' || chart.type === 'line') &&
    Array.isArray(chart.labels) &&
    chart.labels.length <= 500 &&
    Array.isArray(chart.series) &&
    chart.series.length >= 1 &&
    chart.series.length <= 8 &&
    chart.series.every((s) => s && typeof s.name === 'string' && Array.isArray(s.values) && s.values.every((v) => typeof v === 'number' && Number.isFinite(v)));
  if (!ok) throw new OrcoError('invalid', 'A chart needs type bar or line, labels, and 1 to 8 series of numbers');
  return chart;
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** A chart as a standalone page with an inline SVG, light and dark. */
export function chartPage(content: string, title: string): string {
  const chart = parseChart(content);
  const W = 720;
  const H = 360;
  const pad = { l: 48, r: 16, t: 16, b: 48 };
  const values = chart.series.flatMap((s) => s.values);
  const max = Math.max(0, ...values);
  const min = Math.min(0, ...values);
  const span = max - min || 1;
  const n = Math.max(chart.labels.length, ...chart.series.map((s) => s.values.length), 1);
  const x = (i: number) => pad.l + ((W - pad.l - pad.r) * (i + 0.5)) / n;
  const y = (v: number) => pad.t + ((H - pad.t - pad.b) * (max - v)) / span;
  const colors = ['#6b74e8', '#2f9e6e', '#d6a03b', '#e0607e', '#3a9bd8', '#9a6bd8', '#8a8a95', '#c47a3a'];
  const parts: string[] = [];
  for (let k = 0; k <= 4; k++) {
    const v = min + (span * k) / 4;
    parts.push(`<line x1="${pad.l}" x2="${W - pad.r}" y1="${y(v)}" y2="${y(v)}" class="grid"/><text x="${pad.l - 6}" y="${y(v) + 4}" text-anchor="end">${esc(Number(v.toPrecision(3)).toString())}</text>`);
  }
  chart.labels.forEach((label, i) => {
    if (n <= 24 || i % Math.ceil(n / 24) === 0) parts.push(`<text x="${x(i)}" y="${H - pad.b + 18}" text-anchor="middle">${esc(String(label).slice(0, 16))}</text>`);
  });
  const band = (W - pad.l - pad.r) / n;
  chart.series.forEach((s, k) => {
    const color = colors[k % colors.length]!;
    if (chart.type === 'bar') {
      const w = (band * 0.8) / chart.series.length;
      s.values.forEach((v, i) => {
        const left = x(i) - band * 0.4 + w * k;
        parts.push(`<rect x="${left}" y="${Math.min(y(v), y(0))}" width="${Math.max(w - 2, 1)}" height="${Math.abs(y(v) - y(0))}" fill="${color}"><title>${esc(s.name)}: ${v}</title></rect>`);
      });
    } else {
      parts.push(`<polyline fill="none" stroke="${color}" stroke-width="2" points="${s.values.map((v, i) => `${x(i)},${y(v)}`).join(' ')}"/>`);
    }
  });
  const legend = chart.series.map((s, k) => `<span><i style="background:${colors[k % colors.length]}"></i>${esc(s.name)}</span>`).join('');
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${esc(title)}</title><style>
:root{color-scheme:light dark;font:14px/1.4 system-ui,sans-serif}body{margin:16px}svg{width:100%;height:auto}text{font-size:11px;fill:currentColor;opacity:.7}
.grid{stroke:currentColor;opacity:.15}.legend{display:flex;gap:12px;flex-wrap:wrap}.legend i{display:inline-block;width:10px;height:10px;border-radius:2px;margin-right:4px}
</style></head><body>${chart.title ? `<h3>${esc(chart.title)}</h3>` : ''}<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(title)}">${parts.join('')}</svg><div class="legend">${legend}</div></body></html>`;
}

/** Light and dark for pages that do not set it themselves, put first so the page can override. */
export function withTheme(html: string): string {
  const base = '<meta name="color-scheme" content="light dark"><style>:root{color-scheme:light dark}</style>';
  return /<head[^>]*>/i.test(html) ? html.replace(/<head[^>]*>/i, (m) => `${m}${base}`) : `${base}${html}`;
}
