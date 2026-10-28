import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';

export interface WorktreeSettings {
  /** The git repository to branch from. */
  repo: string;
  /** What new branches start from; default origin's default branch, else the repo's HEAD. */
  base?: string;
  /** Where worktrees go; default ~/.orco/worktrees/<repo name>. */
  dir?: string;
  branch_prefix: string;
  /** Fetch from origin before branching (default on; a failed fetch is only logged). */
  fetch: boolean;
}

export interface Workspace {
  path: string;
  branch: string;
  base: string;
}

interface Record {
  agent: string;
  branch: string;
  base: string;
  baseSha: string;
}

export type Git = (args: string[], cwd: string) => Promise<string>;

const runGit: Git = (args, cwd) =>
  new Promise((resolve, reject) => {
    execFile('git', args, { cwd, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, timeout: 120_000 }, (err, stdout, stderr) => {
      if (err) reject(new Error(`git ${args[0]} failed: ${(stderr || err.message).trim().split('\n').slice(-3).join(' ')}`));
      else resolve(stdout.trim());
    });
  });

/**
 * One git worktree and branch per task, so agents working the same repository at once never touch
 * each other's files. A task's worktree is kept while the task is open (resumes and reminders reuse
 * it) and removed when it closes: the branch stays if it has commits, the worktree stays if it has
 * uncommitted changes, so no work is thrown away.
 */
export class Worktrees {
  readonly dir: string;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly settings: WorktreeSettings,
    private readonly log: (message: string) => void,
    private readonly git: Git = runGit,
  ) {
    this.dir = settings.dir ?? join(homedir(), '.orco', 'worktrees', basename(settings.repo));
  }

  /** The task's worktree, made if needed. */
  prepare(taskId: number, agent: string): Promise<Workspace> {
    return this.serial(async () => {
      const path = this.pathOf(taskId);
      const records = this.records();
      const known = records[taskId];
      if (known && existsSync(path)) return { path, branch: known.branch, base: known.base };
      const branch = `${this.settings.branch_prefix}task-${taskId}`;
      if (this.settings.fetch) {
        await this.git(['fetch', '--quiet', 'origin'], this.settings.repo).catch((err: Error) => this.log(`could not fetch, branching from what is here: ${err.message}`));
      }
      const base = this.settings.base ?? (await this.defaultBase());
      mkdirSync(this.dir, { recursive: true });
      await this.git(['worktree', 'prune'], this.settings.repo).catch(() => '');
      const exists = await this.git(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], this.settings.repo).then(
        () => true,
        () => false,
      );
      if (exists) await this.git(['worktree', 'add', path, branch], this.settings.repo);
      else await this.git(['worktree', 'add', '-b', branch, path, base], this.settings.repo);
      const baseSha = known?.baseSha ?? (await this.git(['rev-parse', base], this.settings.repo));
      records[taskId] = { agent, branch, base, baseSha };
      this.save(records);
      this.log(`task #${taskId}: worktree ${path} on ${branch} from ${base}`);
      return { path, branch, base };
    });
  }

  has(taskId: number): boolean {
    return taskId in this.records();
  }

  /** Task ids of this agent's that have a worktree. */
  tasks(agent: string): number[] {
    return Object.entries(this.records())
      .filter(([, record]) => record.agent === agent)
      .map(([id]) => Number(id));
  }

  /** Removes a closed task's worktree, keeping anything that holds work. Returns what happened. */
  cleanup(taskId: number): Promise<string> {
    return this.serial(async () => {
      const records = this.records();
      const record = records[taskId];
      if (!record) return 'no worktree';
      const path = this.pathOf(taskId);
      if (existsSync(path)) {
        const dirty = await this.git(['status', '--porcelain'], path).catch(() => '');
        if (dirty) {
          this.log(`task #${taskId}: kept ${path}, it has uncommitted changes`);
          return `kept ${path}: uncommitted changes`;
        }
        await this.git(['worktree', 'remove', path], this.settings.repo);
      }
      const ahead = Number(await this.git(['rev-list', '--count', `${record.baseSha}..${record.branch}`], this.settings.repo).catch(() => '0'));
      let result: string;
      if (ahead > 0) {
        result = `removed the worktree; kept branch ${record.branch} with ${ahead} commit${ahead === 1 ? '' : 's'}`;
      } else {
        await this.git(['branch', '-D', record.branch], this.settings.repo).catch(() => '');
        result = `removed the worktree and the unused branch ${record.branch}`;
      }
      delete records[taskId];
      this.save(records);
      this.log(`task #${taskId}: ${result}`);
      return result;
    });
  }

  private async defaultBase(): Promise<string> {
    const remote = await this.git(['rev-parse', '--abbrev-ref', 'origin/HEAD'], this.settings.repo).catch(() => '');
    return remote && remote !== 'origin/HEAD' ? remote : 'HEAD';
  }

  private pathOf(taskId: number): string {
    return join(this.dir, `task-${taskId}`);
  }

  private get file(): string {
    return join(this.dir, '.orco-worktrees.json');
  }

  private records(): { [taskId: number]: Record } {
    try {
      return JSON.parse(readFileSync(this.file, 'utf8')) as { [taskId: number]: Record };
    } catch {
      return {};
    }
  }

  private save(records: { [taskId: number]: Record }): void {
    mkdirSync(this.dir, { recursive: true });
    writeFileSync(this.file, JSON.stringify(records, null, 2));
  }

  private serial<T>(work: () => Promise<T>): Promise<T> {
    const next = this.queue.then(work, work);
    this.queue = next.catch(() => {});
    return next;
  }
}
