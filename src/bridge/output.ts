/** Tokens and cost of one run, as far as the agent tool reports them. */
export interface Usage {
  inputTokens: number | null;
  outputTokens: number | null;
  /** Millionths of a US dollar. */
  costMicros: number | null;
}

/** The tool ran out of usage (a plan's limit, a rate limit or an empty balance), and when that may end. */
export interface UsageLimit {
  message: string;
  /** When the limit resets, in ms since the epoch, if the tool said. */
  resetAt: number | null;
}

/** What agent tools print when they cannot go on for lack of usage, quota or credit. */
export const LIMIT =
  /(usage limit|hit your (?:usage |session |weekly )?limit|(?:5|five)[- ]hour limit|rate[ _-]?limit(?:ed| exceeded| reached)|quota (?:exceeded|reached)|insufficient_quota|exceeded your current quota|credit balance is too low|out of (?:credits|usage)|usage_limit_reached|resource_exhausted|too many requests)/i;

/** A reset time in a limit message: a Unix timestamp ("…limit reached|1761750000") or a clock time ("resets 3pm", "try again at 15:30"). */
export function resetTimeOf(message: string, now = Date.now()): number | null {
  const stamp = /\|(\d{10})\b/.exec(message);
  if (stamp) return Number(stamp[1]) * 1000;
  const clock = /(?:resets?|reset at|try again at|available again at)\s*(?:at\s*)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i.exec(message);
  if (!clock) return null;
  let hours = Number(clock[1]);
  const minutes = Number(clock[2] ?? 0);
  const half = clock[3]?.toLowerCase();
  if (half === 'pm' && hours < 12) hours += 12;
  if (half === 'am' && hours === 12) hours = 0;
  if (hours > 23 || minutes > 59) return null;
  const at = new Date(now);
  at.setHours(hours, minutes, 0, 0);
  if (at.getTime() <= now) at.setDate(at.getDate() + 1);
  return at.getTime();
}

const HEAD_BYTES = 64 * 1024;
const TAIL_BYTES = 192 * 1024;
const SNIPPET = 400;

type Json = Record<string, any>;

const ANSI = /\u001b\[[0-9;?]*[A-Za-z]|\u001b\][^\u0007]*\u0007/g;

function snippet(value: unknown, max = SNIPPET): string {
  const text = (typeof value === 'string' ? value : JSON.stringify(value) ?? '').replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/**
 * Collects what an agent run printed: a readable log (Claude Code's stream-json and Codex's --json
 * events rendered as lines, anything else kept as text) and the usage those events report. The log
 * keeps its first 64 KB and last 192 KB.
 */
export class RunOutput {
  private head = '';
  private headBytes = 0;
  /** The tail as lines, dropped from the front as new ones arrive. */
  private tail: string[] = [];
  private tailStart = 0;
  private tailBytes = 0;
  private cutBytes = 0;
  private readonly partial = { stdout: '', stderr: '' };
  private input: number | null = null;
  private output: number | null = null;
  private cost: number | null = null;

  /** Takes a chunk of output; returns the complete lines it rendered, for echoing. */
  feed(stream: 'stdout' | 'stderr', chunk: string): string[] {
    const lines = (this.partial[stream] + chunk).split('\n');
    this.partial[stream] = lines.pop()!;
    return lines.flatMap((line) => this.line(stream, line));
  }

  /** Renders whatever is left of unfinished lines. */
  flush(): string[] {
    const out: string[] = [];
    for (const stream of ['stdout', 'stderr'] as const) {
      if (this.partial[stream]) out.push(...this.line(stream, this.partial[stream]));
      this.partial[stream] = '';
    }
    return out;
  }

  /** Adds a line written by the bridge itself (model runs, worktree notes). */
  note(line: string): void {
    this.append(line);
  }

  /** Adds usage reported some other way (model APIs). */
  addUsage(input: number, output: number, costMicros: number | null): void {
    this.input = (this.input ?? 0) + input;
    this.output = (this.output ?? 0) + output;
    if (costMicros !== null) this.cost = (this.cost ?? 0) + costMicros;
  }

  private limitFound: UsageLimit | null = null;
  private limitStructured = false;
  private lines = 0;
  private limitLine = 0;

  /**
   * Set when the tool said it is out of usage at the very end of its output (the last such message
   * wins): in one of its own error events among the last 15 lines, or as a plain line among the last 3.
   * Anything earlier is the work talking (a git push or a test that hit someone's rate limit).
   */
  get limit(): UsageLimit | null {
    if (!this.limitFound) return null;
    return this.lines - this.limitLine < (this.limitStructured ? 15 : 3) ? this.limitFound : null;
  }

  /** Notes a limit: `structured` when it came from the tool's own error event, or a model API's error. */
  limitHit(message: string, structured = true): void {
    this.limitFound = { message: message.slice(0, 300), resetAt: resetTimeOf(message) };
    this.limitStructured = structured;
    this.limitLine = this.lines;
  }

  get usage(): Usage {
    return { inputTokens: this.input, outputTokens: this.output, costMicros: this.cost };
  }

  get text(): string {
    const tail = this.tail.slice(this.tailStart).join('');
    return this.cutBytes ? `${this.head}\n… ${Math.round(this.cutBytes / 1024)} KB cut …\n${tail}` : this.head + tail;
  }

  /** The last characters of the log, for a task note. */
  last(chars: number): string {
    return this.text.slice(-chars);
  }

  private line(stream: 'stdout' | 'stderr', raw: string): string[] {
    const text = raw.replace(ANSI, '').replace(/\r$/, '');
    if (!text.trim()) return [];
    this.lines++;
    let rendered: string[] | null = null;
    let event: Json | null = null;
    if (stream === 'stdout' && text.startsWith('{')) {
      try {
        event = JSON.parse(text) as Json;
        rendered = this.event(event);
      } catch {
        rendered = null;
      }
    }
    // What the agent wrote or read while working (it may be building a rate limiter) is not the tool
    // saying it ran out: only error events, stderr and plain output count.
    const working = event !== null && (event.type === 'assistant' || event.type === 'user' || (event.type === 'item.completed' && event.item?.type !== 'error'));
    if (!working && LIMIT.test(text)) this.limitHit(text, event !== null);
    const lines = rendered ?? [stream === 'stderr' ? `[stderr] ${text}` : text];
    for (const line of lines) this.append(line);
    return lines;
  }

  /** Renders one JSON event from a known agent tool; null if it is not one. */
  private event(e: Json): string[] | null {
    // Claude Code: claude -p --output-format stream-json --verbose
    if (e.type === 'system' && e.subtype === 'init') return [`· session started${e.model ? ` (${e.model})` : ''}`];
    if ((e.type === 'assistant' || e.type === 'user') && Array.isArray(e.message?.content)) {
      return (e.message.content as Json[]).flatMap((block): string[] => {
        if (block.type === 'text' && block.text?.trim()) return [`${e.type === 'assistant' ? 'assistant' : 'user'}: ${block.text.trim()}`];
        if (block.type === 'tool_use') return [`→ ${block.name} ${snippet(block.input)}`];
        if (block.type === 'tool_result') {
          const content = Array.isArray(block.content) ? block.content.map((c: Json) => c.text ?? `[${c.type}]`).join(' ') : block.content;
          return [`← ${block.is_error ? 'error: ' : ''}${snippet(content)}`];
        }
        return [];
      });
    }
    if (e.type === 'result' && ('total_cost_usd' in e || 'usage' in e || 'modelUsage' in e)) {
      this.claudeUsage(e);
      const cost = typeof e.total_cost_usd === 'number' ? `, $${e.total_cost_usd.toFixed(4)}` : '';
      return [`· finished: ${e.subtype ?? (e.is_error ? 'error' : 'done')}${e.num_turns ? `, ${e.num_turns} turns` : ''}${cost}`];
    }
    // Codex: codex exec --json
    if (e.type === 'thread.started') return ['· session started'];
    if (e.type === 'turn.started' || e.type === 'item.started' || e.type === 'item.updated') return [];
    if (e.type === 'turn.completed') {
      const u = e.usage ?? {};
      this.input = (this.input ?? 0) + (Number(u.input_tokens) || 0);
      this.output = (this.output ?? 0) + (Number(u.output_tokens) || 0);
      return [];
    }
    if (e.type === 'turn.failed' || e.type === 'error') return [`! ${snippet(e.error?.message ?? e.message ?? e.error)}`];
    if (e.type === 'item.completed' && e.item) {
      const item = e.item as Json;
      if (item.type === 'agent_message') return [`assistant: ${String(item.text ?? '').trim()}`];
      if (item.type === 'reasoning') return [];
      if (item.type === 'command_execution') {
        return [`$ ${item.command}${item.exit_code !== undefined && item.exit_code !== null ? ` (exit ${item.exit_code})` : ''}`, ...(item.aggregated_output ? [`← ${snippet(item.aggregated_output)}`] : [])];
      }
      if (item.type === 'mcp_tool_call') return [`→ ${item.server ?? 'mcp'}.${item.tool ?? '?'} ${snippet(item.arguments ?? '')}`.trimEnd()];
      if (item.type === 'file_change') return [`✎ ${(item.changes ?? []).map((c: Json) => `${c.kind ?? 'changed'} ${c.path}`).join(', ') || 'files changed'}`];
      if (item.type === 'error') return [`! ${snippet(item.message)}`];
      return [`· ${item.type}`];
    }
    return null;
  }

  private claudeUsage(e: Json): void {
    if (typeof e.total_cost_usd === 'number') this.cost = (this.cost ?? 0) + Math.round(e.total_cost_usd * 1e6);
    const sum = (u: Json | undefined, keys: string[]) => keys.reduce((n, k) => n + (Number(u?.[k]) || 0), 0);
    if (e.usage) {
      this.input = (this.input ?? 0) + sum(e.usage, ['input_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens']);
      this.output = (this.output ?? 0) + sum(e.usage, ['output_tokens']);
    } else if (e.modelUsage) {
      for (const u of Object.values(e.modelUsage as Record<string, Json>)) {
        this.input = (this.input ?? 0) + sum(u, ['inputTokens', 'cacheCreationInputTokens', 'cacheReadInputTokens']);
        this.output = (this.output ?? 0) + sum(u, ['outputTokens']);
      }
    }
  }

  private append(line: string): void {
    const text = `${line}\n`;
    const bytes = Buffer.byteLength(text);
    if (this.tailBytes === 0 && this.headBytes + bytes <= HEAD_BYTES) {
      this.head += text;
      this.headBytes += bytes;
      return;
    }
    this.tail.push(text);
    this.tailBytes += bytes;
    while (this.tailBytes > TAIL_BYTES && this.tailStart < this.tail.length - 1) {
      const dropped = Buffer.byteLength(this.tail[this.tailStart]!);
      this.tailStart++;
      this.tailBytes -= dropped;
      this.cutBytes += dropped;
    }
    if (this.tailStart > 4096) {
      this.tail = this.tail.slice(this.tailStart);
      this.tailStart = 0;
    }
  }
}
