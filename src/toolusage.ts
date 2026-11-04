import { OrcoError } from './errors.js';
import type { Participant, Store } from './store.js';

/*
 * MCP tool use (#103): per agent, tool and day, the calls, errors by code, reply bytes and time.
 * Kept in this database only, never sent anywhere; org admins read it to see which replies to trim
 * and which tools agents misuse or never call. Days older than 90 are dropped.
 */

const KEEP_DAYS = 90;

export interface ToolUsageRow {
  tool: string;
  calls: number;
  errors: number;
  errorCodes: Record<string, number>;
  avgBytes: number;
  maxBytes: number;
  avgMs: number;
  agents: number;
}

export class ToolUsage {
  private lastPrune = '';

  constructor(private readonly store: Store) {}

  record(actor: Participant, tool: string, call: { bytes: number; ms: number; error: string | null }): void {
    const day = new Date(this.store.now()).toISOString().slice(0, 10);
    try {
      const row = this.store.db.prepare('SELECT error_codes FROM tool_usage WHERE day = ? AND participant_id = ? AND tool = ?').get(day, actor.id, tool) as { error_codes: string } | undefined;
      const codes = row ? (JSON.parse(row.error_codes) as Record<string, number>) : {};
      if (call.error) codes[call.error] = (codes[call.error] ?? 0) + 1;
      this.store.db
        .prepare(
          `INSERT INTO tool_usage (day, participant_id, tool, calls, errors, error_codes, bytes, max_bytes, ms) VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?)
           ON CONFLICT (day, participant_id, tool) DO UPDATE SET calls = calls + 1, errors = errors + excluded.errors, error_codes = excluded.error_codes,
             bytes = bytes + excluded.bytes, max_bytes = max(max_bytes, excluded.max_bytes), ms = ms + excluded.ms`,
        )
        .run(day, actor.id, tool, call.error ? 1 : 0, JSON.stringify(codes), call.bytes, call.bytes, Math.round(call.ms));
      if (this.lastPrune !== day) {
        this.lastPrune = day;
        const cutoff = new Date(this.store.now() - KEEP_DAYS * 86_400_000).toISOString().slice(0, 10);
        this.store.db.prepare('DELETE FROM tool_usage WHERE day < ?').run(cutoff);
      }
    } catch {
      // Counting never gets in the way of a tool call.
    }
  }

  /** Totals per tool over the last days, biggest replies first. Org admins only. */
  summary(actor: Participant, days = 7): ToolUsageRow[] {
    if (actor.kind !== 'user' || !this.store.isOrgAdmin(actor)) throw new OrcoError('forbidden', 'Only org admins see tool use');
    const from = new Date(this.store.now() - Math.min(Math.max(days, 1), KEEP_DAYS) * 86_400_000).toISOString().slice(0, 10);
    const rows = this.store.db
      .prepare(
        `SELECT tool, sum(calls) AS calls, sum(errors) AS errors, sum(bytes) AS bytes, max(max_bytes) AS max_bytes, sum(ms) AS ms,
                count(DISTINCT participant_id) AS agents, group_concat(error_codes, '|') AS codes
         FROM tool_usage WHERE day >= ? GROUP BY tool`,
      )
      .all(from) as { tool: string; calls: number; errors: number; bytes: number; max_bytes: number; ms: number; agents: number; codes: string }[];
    return rows
      .map((r) => {
        const errorCodes: Record<string, number> = {};
        for (const part of r.codes.split('|')) for (const [k, v] of Object.entries(JSON.parse(part || '{}') as Record<string, number>)) errorCodes[k] = (errorCodes[k] ?? 0) + v;
        return { tool: r.tool, calls: r.calls, errors: r.errors, errorCodes, avgBytes: Math.round(r.bytes / r.calls), maxBytes: r.max_bytes, avgMs: Math.round(r.ms / r.calls), agents: r.agents };
      })
      .sort((a, b) => b.avgBytes * b.calls - a.avgBytes * a.calls);
  }
}
