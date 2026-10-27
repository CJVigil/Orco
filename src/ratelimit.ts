export class RateLimiter {
  private readonly hits = new Map<string, number[]>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  blocked(key: string): boolean {
    return this.recent(key).length >= this.limit;
  }

  hit(key: string): void {
    const times = this.recent(key);
    times.push(this.now());
    this.hits.set(key, times);
    if (this.hits.size > 10_000) this.prune();
  }

  private recent(key: string): number[] {
    const cutoff = this.now() - this.windowMs;
    const times = (this.hits.get(key) ?? []).filter((t) => t > cutoff);
    if (times.length) this.hits.set(key, times);
    else this.hits.delete(key);
    return times;
  }

  private prune(): void {
    for (const key of [...this.hits.keys()]) this.recent(key);
  }
}
