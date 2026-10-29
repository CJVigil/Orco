import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, extname, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { parseArgs } from 'node:util';
import { Backups, backupTo, networkFilesystemWarning, restore } from './backups.js';
import { Bridge } from './bridge/bridge.js';
import { loadBridgeConfig } from './bridge/config.js';
import { doctor } from './bridge/doctor.js';
import { ForgeSync, loadForgeSyncConfig } from './sync/forge.js';
import { connect, DEFAULT_CONFIG, DEFAULT_TOKEN_DIR } from './connect.js';
import { CLIENT_COMMANDS, CLIENT_USAGE, readStdin, runClient } from './client.js';
import { checkTimeZone, parseCron } from './cron.js';
import { openDatabase } from './db.js';
import { createApp } from './http.js';
import { importTickets, parseImport } from './import.js';
import { parseSecretsKey } from './secrets.js';
import { installSkill, skillText } from './skill.js';
import { type Limits, OrcoError, Store, type TaskPolicy } from './store.js';

const USAGE = `Usage: orco <command> [options]

Server commands (run where the database lives):
  serve                      Start the server
  user add <name> [--admin]  Create a user and print their token (the first user is an org admin)
  user admin <name> [--off]  Make a user an org admin, or stop
  user link <name>           Print a one-time sign-in link for a person (an invite, or a way back in)
  agent add <owner> <name>   Create an agent owned by a user and print its token
  token rotate <name>        Replace a user's or agent's token and print the new one
  agent policy <agent> <p>   Who may give the agent tasks: open, ask (default) or owner_only
  agent trust <agent> <user> Let a user's tasks reach the agent without asking (untrust to undo)
  audit export [--since N]   Print the audit log as JSON lines
  backup <file>              Write a consistent copy of the database, safe while serving
  restore <file> [--force]   Replace the database with a backup (stop the server first)
  import <project> <file> --as <user> [--create-labels] [--create-milestones] [--dry-run]
                             File tickets from a JSON or CSV file, as that person
  version                    Print the version
  list                       List users and agents

Bridge commands (run on each developer's machine):
  connect <server>           Join this computer: approve a code in the browser, and your agents run here
                             [--dir <folder>] [--service: start at login] [--no-start]
  bridge                     Wake local agents when they are assigned tasks
  bridge example             Print an example bridge config
  bridge doctor              Check each bridge agent: token, tool installed, flags, model API
  sync gitea <config> [--once]   Keep Gitea/Forgejo issues and Orco tickets in step
  sync github <config> [--once]  The same for GitHub (see docs/forge-sync.md)

Agent setup:
  skill                      Print the orco skill (how to work in Orco) for any agent tool
  skill install --for claude|codex|agents [--project]   Install it where that tool looks
  skill install --dir <dir>  Install it into another tool's skills directory

Options:
  --config <path> Bridge config (env ORCO_BRIDGE_CONFIG, default ./orco-bridge.json)
  --db <path>     SQLite file (env ORCO_DB, default ./orco.db)
  --host <host>   Address to listen on (env ORCO_HOST, default 127.0.0.1)
  --port <port>   Port to listen on (env ORCO_PORT, default 7420)
`;

const VERSION = (createRequire(import.meta.url)('../package.json') as { version: string }).version;

function backupsFromEnv(store: Store): Backups | null {
  const dir = process.env.ORCO_BACKUP_DIR?.trim();
  if (!dir) return null;
  const number = (key: string, fallback: number) => {
    const raw = process.env[key]?.trim();
    return raw ? Number(raw) : fallback;
  };
  return new Backups(store.db, { dir, everyHours: number('ORCO_BACKUP_HOURS', 24), keep: number('ORCO_BACKUP_KEEP', 14), log: (m) => console.log(m) });
}

/** ORCO_DIGEST is a cron line (default "0 9 * * 1", Mondays at 9) or "off"; ORCO_DIGEST_TZ its time zone. */
function digestFromEnv(): { cron: string; tz: string } | null {
  const cron = process.env.ORCO_DIGEST?.trim() || '0 9 * * 1';
  if (cron === 'off') return null;
  parseCron(cron);
  return { cron, tz: checkTimeZone(process.env.ORCO_DIGEST_TZ?.trim() || 'UTC') };
}

function limitsFromEnv(): Partial<Limits> {
  const read = (key: string) => {
    const value = process.env[key]?.trim();
    // Compose and Komodo pass unset variables as empty strings: treat those as unset, not as 0.
    if (value === undefined || value === '') return undefined;
    const n = Number(value);
    if (!Number.isInteger(n) || n < 0) throw new OrcoError('invalid', `${key} must be a non-negative integer`);
    return n;
  };
  const limits: Partial<Limits> = {
    maxTaskDepth: read('ORCO_MAX_TASK_DEPTH'),
    agentPostsPerMinute: read('ORCO_AGENT_POSTS_PER_MINUTE'),
    agentTasksPerMinute: read('ORCO_AGENT_TASKS_PER_MINUTE'),
    taskStallMinutes: read('ORCO_TASK_STALL_MINUTES'),
    escalateHours: read('ORCO_ESCALATE_HOURS'),
    runLogDays: read('ORCO_RUN_LOG_DAYS'),
  };
  return Object.fromEntries(Object.entries(limits).filter(([, v]) => v !== undefined));
}

const EXAMPLE_BRIDGE_CONFIG = {
  server: 'https://orco.example.internal',
  agents: [
    { name: 'carlos-claude', token_env: 'ORCO_TOKEN_CARLOS_CLAUDE', preset: 'claude', cwd: '~/code/my-repo', timeout_seconds: 1800 },
    { name: 'carlos-codex', token_env: 'ORCO_TOKEN_CARLOS_CODEX', preset: 'codex', cwd: '~/code/my-repo' },
    {
      name: 'carlos-local',
      token_env: 'ORCO_TOKEN_CARLOS_LOCAL',
      model: { base_url: 'http://localhost:11434/v1', name: 'qwen3:14b' },
    },
  ],
};

const DEFAULT_BRIDGE_CONFIG = './orco-bridge.json';

/** ./orco-bridge.json if there is one, else the config orco connect writes, if there is one. */
function defaultBridgeConfig(): string {
  if (!existsSync(DEFAULT_BRIDGE_CONFIG) && existsSync(DEFAULT_CONFIG)) return DEFAULT_CONFIG;
  return DEFAULT_BRIDGE_CONFIG;
}

async function runBridge(path: string): Promise<void> {
  let config: ReturnType<typeof loadBridgeConfig>;
  let bridge: Bridge;
  try {
    config = loadBridgeConfig(path);
    bridge = new Bridge(config);
    await bridge.start();
  } catch (err) {
    console.error((err as Error).message);
    process.exit(1);
  }
  console.log(`Bridge running for ${config.agents.map((a) => a.name).join(', ')} against ${config.server}`);
  const shutdown = () => {
    console.log('Stopping bridge');
    void bridge.stop().then(() => process.exit(0));
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}

export function main(): void {
  // Client commands talk to a server over HTTP and take their own options.
  const first = process.argv[2];
  if (first && CLIENT_COMMANDS.has(first)) {
    void runClient(process.argv.slice(2), {
      env: process.env,
      out: (text) => process.stdout.write(text.endsWith('\n') ? text : `${text}\n`),
      err: (text) => process.stderr.write(text.endsWith('\n') ? text : `${text}\n`),
      stdin: readStdin,
    }).then(
      (code) => {
        process.exitCode = code;
      },
      (err: Error) => {
        console.error(err.message);
        process.exitCode = 1;
      },
    );
    return;
  }
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      db: { type: 'string', default: process.env.ORCO_DB ?? './orco.db' },
      host: { type: 'string', default: process.env.ORCO_HOST ?? '127.0.0.1' },
      port: { type: 'string', default: process.env.ORCO_PORT ?? '7420' },
      config: { type: 'string', default: process.env.ORCO_BRIDGE_CONFIG ?? defaultBridgeConfig() },
      since: { type: 'string' },
      as: { type: 'string' },
      'create-labels': { type: 'boolean' },
      'create-milestones': { type: 'boolean' },
      'dry-run': { type: 'boolean' },
      force: { type: 'boolean' },
      once: { type: 'boolean' },
      admin: { type: 'boolean' },
      service: { type: 'boolean' },
      'no-start': { type: 'boolean' },
      off: { type: 'boolean' },
      for: { type: 'string' },
      dir: { type: 'string' },
      project: { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
      version: { type: 'boolean', short: 'v' },
    },
  });
  const [command, sub, ...args] = positionals;
  if (values.version || command === 'version') {
    console.log(VERSION);
    return;
  }
  if (values.help || !command) {
    process.stdout.write(`${USAGE}\n${CLIENT_USAGE}`);
    return;
  }

  if (command === 'bridge') {
    if (sub === 'example') {
      process.stdout.write(`${JSON.stringify(EXAMPLE_BRIDGE_CONFIG, null, 2)}\n`);
      return;
    }
    if (sub === 'doctor') {
      const config = loadBridgeConfig(values.config);
      void doctor(config, process.env).then((findings) => {
        for (const f of findings) console.log(`${f.ok ? 'ok  ' : 'FAIL'} ${f.agent}: ${f.text}`);
        if (findings.some((f) => !f.ok)) process.exitCode = 1;
      });
      return;
    }
    if (sub !== undefined) throw new OrcoError('invalid', `Unknown bridge command ${sub}`);
    void runBridge(values.config);
    return;
  }

  if (command === 'skill') {
    if (sub === undefined || sub === 'print') {
      process.stdout.write(skillText());
      return;
    }
    if (sub !== 'install') throw new OrcoError('invalid', 'Usage: orco skill [print] | orco skill install --for claude|codex|agents [--project] | --dir <dir>');
    const path = installSkill({ target: values.for, dir: values.dir, project: values.project });
    console.log(`Installed the orco skill at ${path}. Run this again after upgrading Orco to update it.`);
    return;
  }

  // Restoring replaces the database file, so it runs before anything opens it.
  if (command === 'restore') {
    if (!sub) throw new OrcoError('invalid', 'Usage: orco restore <backup file> [--force]');
    const { replaced } = restore(sub, values.db, { force: values.force });
    console.log(`Restored ${values.db} from ${sub}.${replaced ? ` The database it replaced is at ${replaced}.` : ''}`);
    return;
  }

  if (command === 'connect') {
    if (!sub) throw new OrcoError('invalid', 'Usage: orco connect <server address> [--dir <folder>] [--service] [--no-start]');
    const config = values.config === DEFAULT_BRIDGE_CONFIG ? DEFAULT_CONFIG : values.config;
    // Run through `npx <server>/install/…`: nothing is installed, so say how to run it again.
    const viaNpx = /[\\/]_npx[\\/]/.test(process.argv[1] ?? '');
    const again = viaNpx ? `npx -y ${sub.replace(/\/+$/, '')}/install/orco-${VERSION}.tgz` : 'orco';
    if (viaNpx && values.service) {
      throw new OrcoError(
        'invalid',
        `A service needs Orco installed for good, not run through npx. Install it, then run connect again:\n  npm install -g ${sub.replace(/\/+$/, '')}/install/orco-${VERSION}.tgz\n  orco connect ${sub} --service`,
      );
    }
    void connect(
      { server: sub, dir: resolve(values.dir ?? process.cwd()), config, tokenDir: DEFAULT_TOKEN_DIR, service: values.service === true },
      { out: (text) => console.log(text) },
    )
      .then(async () => {
        const findings = await doctor(loadBridgeConfig(config), process.env);
        const problems = findings.filter((f) => !f.ok);
        for (const f of problems) console.log(`  needs attention · ${f.agent}: ${f.text}`);
        if (!problems.length) console.log('Everything checks out.');
        if (values.service || values['no-start']) {
          if (!values.service) console.log(`Start it with: ${again} bridge`);
          return;
        }
        console.log(`Starting the bridge now. Ctrl+C stops it; start it again with: ${again} bridge`);
        await runBridge(config);
      })
      .catch((err: Error) => {
        console.error(err.message);
        process.exitCode = 1;
      });
    return;
  }

  if (command === 'sync') {
    if ((sub !== 'gitea' && sub !== 'github') || !args[0]) throw new OrcoError('invalid', 'Usage: orco sync gitea|github <config.json> [--once]');
    const config = loadForgeSyncConfig(args[0], sub);
    const orcoToken = process.env[config.orco.token_env];
    const forgeToken = process.env[config.forge.token_env];
    if (!orcoToken || !forgeToken) throw new OrcoError('invalid', `Set ${config.orco.token_env} and ${config.forge.token_env} first`);
    const sync = new ForgeSync(config, { orco: orcoToken, forge: forgeToken }, (m) => console.log(`${new Date().toISOString()} ${m}`));
    if (values.once) {
      void sync.runOnce().catch((err: Error) => {
        console.error(err.message);
        process.exitCode = 1;
      });
      return;
    }
    const stop = new AbortController();
    process.once('SIGINT', () => stop.abort());
    process.once('SIGTERM', () => stop.abort());
    console.log(`Syncing ${config.repos.map((r) => `${r.repo} ↔ ${r.project}`).join(', ')} every ${config.poll_seconds}s`);
    void sync.run(stop.signal);
    return;
  }

  const store = new Store(openDatabase(values.db, { snapshotDir: process.env.ORCO_BACKUP_DIR?.trim() || dirname(resolve(values.db)), log: (m) => console.log(m) }), { limits: limitsFromEnv(), secretsKey: parseSecretsKey(process.env.ORCO_SECRETS_KEY), digest: digestFromEnv() });
  const key = sub && !['serve', 'list', 'backup', 'import'].includes(command) ? `${command} ${sub}` : command;

  switch (key) {
    case 'serve': {
      const publicUrl = process.env.ORCO_PUBLIC_URL || undefined;
      // Until someone has an account, a one-time code lets the first person set Orco up in the browser.
      const setupCode = store.onboarding.setupNeeded() ? randomBytes(9).toString('base64url') : undefined;
      const { app, close, oauth } = createApp(store, { publicUrl, setupCode });
      const warning = networkFilesystemWarning(values.db);
      if (warning) console.error(warning);
      const backups = backupsFromEnv(store);
      const backupTimer = backups
        ? setInterval(() => {
            try {
              backups.runIfDue();
            } catch (err) {
              console.error(`Scheduled backup failed: ${(err as Error).message}`);
            }
          }, 3600_000)
        : null;
      backupTimer?.unref();
      if (backups) {
        try {
          backups.runIfDue();
        } catch (err) {
          console.error(`Scheduled backup failed: ${(err as Error).message}`);
        }
      }
      const trust = process.env.ORCO_TRUST_PROXY?.trim();
      // A number is a hop count ("1": one proxy in front); anything else is Express's list of addresses or names.
      if (trust) app.set('trust proxy', /^\d+$/.test(trust) ? Number(trust) : trust === 'true' ? true : trust);
      const port = Number(values.port);
      if (!Number.isInteger(port) || port < 1 || port > 65535) throw new OrcoError('invalid', `Invalid port ${values.port}`);
      const server = app.listen(port, values.host, () => {
        console.log(`Orco ${VERSION} listening on http://${values.host}:${port}`);
        console.log(`  MCP endpoint: http://${values.host}:${port}/mcp`);
        console.log(`  Database: ${values.db}`);
        if (oauth) console.log(`  OAuth for cloud agents: on, issuer ${oauth.issuer}`);
        if (backups) console.log(`  Backups: every ${process.env.ORCO_BACKUP_HOURS || 24}h to ${process.env.ORCO_BACKUP_DIR}`);
        if (values.host !== '127.0.0.1' && values.host !== 'localhost') {
          console.log('  Not bound to localhost: put TLS in front of this (see docs/deploy.md).');
        }
        if (setupCode) {
          const base = serverBase(values);
          console.log('');
          console.log('  No one has an account yet. Open this link to set up Orco and make yours:');
          console.log(`  ${base}/#setup=${setupCode}`);
          console.log('  (or run: orco user add <your-name>)');
        }
      });
      server.on('error', (err) => {
        console.error(`Could not listen on ${values.host}:${port}: ${err.message}`);
        process.exit(1);
      });
      const shutdown = (signal: string) => {
        console.log(`${signal} received, shutting down`);
        if (backupTimer) clearInterval(backupTimer);
        server.close();
        server.closeAllConnections();
        void close().finally(() => {
          store.db.close();
          process.exit(0);
        });
        setTimeout(() => process.exit(1), 5_000).unref();
      };
      process.once('SIGINT', () => shutdown('SIGINT'));
      process.once('SIGTERM', () => shutdown('SIGTERM'));
      return;
    }
    case 'user add': {
      const [name] = args;
      if (!name) throw new OrcoError('invalid', 'Usage: orco user add <name> [--admin]');
      const { participant, token } = store.createUser(name, { orgAdmin: values.admin });
      const admin = store.isOrgAdmin(participant) ? ' (an org admin)' : '';
      const link = store.signins.createLink(null, name);
      console.log(`Created user ${name}${admin}. Send them this link to sign in (works once, for 7 days):\n${serverBase(values)}/#signin=${link.code}`);
      console.log(`Their token for the command line (shown once):\n${token}`);
      return;
    }
    case 'user link': {
      const [name] = args;
      if (!name) throw new OrcoError('invalid', 'Usage: orco user link <name>');
      const link = store.signins.createLink(null, name);
      console.log(`Sign-in link for ${name} (works once, for 7 days):\n${serverBase(values)}/#signin=${link.code}`);
      return;
    }
    case 'user admin': {
      const [name] = args;
      if (!name) throw new OrcoError('invalid', 'Usage: orco user admin <name> [--off]');
      store.setOrgAdmin(name, !values.off);
      console.log(values.off ? `${name} is no longer an org admin.` : `${name} is now an org admin: they see every project in the portfolio and manage groups, org policies and budgets.`);
      return;
    }
    case 'agent add': {
      const [owner, name] = args;
      if (!owner || !name) throw new OrcoError('invalid', 'Usage: orco agent add <owner> <name>');
      const { token } = store.createAgent(owner, name);
      console.log(`Created agent ${name} owned by ${owner}. Token (shown once):\n${token}`);
      return;
    }
    case 'token rotate': {
      const [name] = args;
      if (!name) throw new OrcoError('invalid', 'Usage: orco token rotate <name>');
      console.log(`New token for ${name} (shown once):\n${store.rotateToken(name)}`);
      return;
    }
    case 'agent policy': {
      const [name, policy] = args;
      if (!name || !policy) throw new OrcoError('invalid', 'Usage: orco agent policy <agent> <open|ask|owner_only>');
      const settings = store.setTaskPolicy(null, name, policy as TaskPolicy);
      console.log(`${settings.name} now has task policy ${settings.taskPolicy}`);
      return;
    }
    case 'agent trust':
    case 'agent untrust': {
      const [name, user] = args;
      if (!name || !user) throw new OrcoError('invalid', `Usage: orco ${key} <agent> <user>`);
      const settings = store.setTrust(null, name, user, sub === 'trust');
      console.log(`${settings.name} trusts: ${settings.trusted.join(', ') || 'nobody beyond its owner'}`);
      return;
    }
    case 'backup': {
      const target = sub;
      if (!target) throw new OrcoError('invalid', 'Usage: orco backup <file>');
      backupTo(store.db, target);
      console.log(`Backed up ${values.db} to ${target}`);
      return;
    }
    case 'import': {
      const [project, file] = [sub, ...args];
      if (!project || !file || !values.as) {
        throw new OrcoError('invalid', 'Usage: orco import <project> <file.json|file.csv> --as <user> [--create-labels] [--create-milestones] [--dry-run]');
      }
      const person = store.participantByName(values.as);
      if (!person || person.kind !== 'user') throw new OrcoError('not_found', `No user named ${values.as}`);
      const rows = parseImport(readFileSync(file, 'utf8'), extname(file).toLowerCase() === '.csv' ? 'csv' : 'json');
      const result = importTickets(store, person, project, rows, {
        createLabels: values['create-labels'],
        createMilestones: values['create-milestones'],
        dryRun: values['dry-run'],
      });
      if (result.labelsCreated.length) console.log(`${result.dryRun ? 'Would create' : 'Created'} labels: ${result.labelsCreated.join(', ')}`);
      if (result.milestonesCreated.length) console.log(`${result.dryRun ? 'Would create' : 'Created'} milestones: ${result.milestonesCreated.join(', ')}`);
      for (const t of result.created) console.log(`${t.ref ?? `row ${t.row}`}\t${t.title}`);
      console.log(result.dryRun ? `Checked ${result.created.length} tickets; nothing was written (drop --dry-run to import).` : `Imported ${result.created.length} tickets into ${project}.`);
      return;
    }
    case 'audit export': {
      for (const entry of store.audit.all(Number(values.since ?? 0))) process.stdout.write(`${JSON.stringify(entry)}\n`);
      return;
    }
    case 'list': {
      for (const p of store.listParticipants()) console.log(`${p.kind}\t${p.name}${p.owner ? `\t(owner: ${p.owner})` : ''}`);
      return;
    }
    default:
      process.stderr.write(USAGE);
      process.exitCode = 1;
  }
}

/** The address people open, for links printed on the server: ORCO_PUBLIC_URL, or the address it listens on. */
function serverBase(values: { host?: string; port?: string }): string {
  const publicUrl = process.env.ORCO_PUBLIC_URL;
  const host = values.host === '0.0.0.0' || !values.host ? 'localhost' : values.host;
  return (publicUrl || `http://${host}:${values.port ?? '7420'}`).replace(/\/+$/, '');
}
