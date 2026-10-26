export interface ServerEvent {
  event: string;
  data: unknown;
}

export interface EventStreamOptions {
  url: string;
  headers: Record<string, string>;
  onEvent: (event: ServerEvent) => void;
  onStatus?: (status: 'connected' | 'disconnected', detail?: string) => void;
  minBackoffMs?: number;
  maxBackoffMs?: number;
}

export class EventStream {
  private readonly controller = new AbortController();
  private stopped = false;

  constructor(private readonly options: EventStreamOptions) {}

  start(): Promise<void> {
    return this.loop();
  }

  stop(): void {
    this.stopped = true;
    this.controller.abort();
  }

  private async loop(): Promise<void> {
    const min = this.options.minBackoffMs ?? 1_000;
    const max = this.options.maxBackoffMs ?? 30_000;
    let backoff = min;
    while (!this.stopped) {
      try {
        const res = await fetch(this.options.url, { headers: this.options.headers, signal: this.controller.signal });
        if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
        this.options.onStatus?.('connected');
        backoff = min;
        await this.read(res.body);
        if (!this.stopped) this.options.onStatus?.('disconnected', 'stream ended');
      } catch (err) {
        if (this.stopped) return;
        this.options.onStatus?.('disconnected', (err as Error).message);
      }
      if (this.stopped) return;
      await new Promise((resolve) => setTimeout(resolve, backoff));
      backoff = Math.min(backoff * 2, max);
    }
  }

  private async read(body: ReadableStream<Uint8Array>): Promise<void> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return;
      buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n');
      let end: number;
      while ((end = buffer.indexOf('\n\n')) !== -1) {
        const chunk = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        let event = 'message';
        const data: string[] = [];
        for (const line of chunk.split('\n')) {
          if (line.startsWith('event:')) event = line.slice(6).trim();
          else if (line.startsWith('data:')) data.push(line.slice(5).trimStart());
        }
        if (data.length === 0) continue;
        try {
          this.options.onEvent({ event, data: JSON.parse(data.join('\n')) });
        } catch {
          // A malformed frame is skipped; the next one may be fine.
        }
      }
    }
  }
}
