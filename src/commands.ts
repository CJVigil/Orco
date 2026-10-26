import { parseArgs } from 'node:util';
import { Bridge } from './bridge/bridge.js';
import { loadBridgeConfig } from './bridge/config.js';
import { openDatabase } from './db.js';
import { createApp } from './http.js';
import { type Limits, OrcoError, Store, type TaskPolicy } from './store.js';

const USAGE = `Usage: orco <command> [options]

Server commands (run where the database lives):
  serve                      Start the server
  user add <name>            Create a user and print their token
  agent add <owner> <name>   Create an agent owned by a user and print its token
  token rotate <name>        Replace a user's or agent's token and print the new one
  agent policy <agent> <p>   Who may give the agent tasks: open, ask (default) or owner_only
  agent trust <agent> <user> Let a user's tasks reach the agent without asking (untrust to undo)
  audit export [--since N]   Print the audit log as JSON lines
  list                       List users and agents

Bridge commands (run on each developer's machine):
  bridge                     Wake local agents when they are assigned tasks
  bridge example             Print an example bridge config

Options:
  --config <path> Bridge config (env ORCO_BRIDGE_CONFIG, default ./orco-bridge.json)
  --db <path>     SQLite file (env ORCO_DB, default ./orco.db)
  --host <host>   Address to listen on (env ORCO_HOST, default 127.0.0.1)
  --port <port>   Port to listen on (env ORCO_PORT, default 7420)
`;

function limitsFromEnv(): Partial<Limits> {
  const read = (key: string) => {
    const value = process.env[key];
    if (value === undefined) return undefined;
    const n = Number(value);
    if (!Number.isInteger(n) || n < 0) throw new OrcoError('invalid', `${key} must be a non-negative integer`);
    return n;
  };
  const limits: Partial<Limits> = {
    maxTaskDepth: read('ORCO_MAX_TASK_DEPTH'),
    agentPostsPerMinute: read('ORCO_AGENT_POSTS_PER_MINUTE'),
    agentTasksPerMinute: read('ORCO_AGENT_TASKS_PER_MINUTE'),
  };
  return Object.fromEntries(Object.entries(limits).filter(([, v]) => v !== undefined));
}

const EXAMPLE_BRIDGE_CONFIG = {
  server: 'https://orco.example.internal',
  agents: [
    {
      name: 'carlos-claude',
      token_env: 'ORCO_TOKEN_CARLOS_CLAUDE',
      command: ['claude', '-p', '{prompt}', '--allowedTools', 'mcp__orco'],
      cwd: '~/code/my-repo',
      timeout_seconds: 1800,
      max_concurrent: 1,
    },
    {
      name: 'carlos-codex',
      token_env: 'ORCO_TOKEN_CARLOS_CODEX',
      command: ['codex', 'exec', '{prompt}'],
      cwd: '~/code/my-repo',
    },
  ],
};

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
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      db: { type: 'string', default: process.env.ORCO_DB ?? './orco.db' },
      host: { type: 'string', default: process.env.ORCO_HOST ?? '127.0.0.1' },
      port: { type: 'string', default: process.env.ORCO_PORT ?? '7420' },
      config: { type: 'string', default: process.env.ORCO_BRIDGE_CONFIG ?? './orco-bridge.json' },
      since: { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  const [command, sub, ...args] = positionals;
  if (values.help || !command) {
    process.stdout.write(USAGE);
    return;
  }

  if (command === 'bridge') {
    if (sub === 'example') {
      process.stdout.write(`${JSON.stringify(EXAMPLE_BRIDGE_CONFIG, null, 2)}\n`);
      return;
    }
    if (sub !== undefined) throw new OrcoError('invalid', `Unknown bridge command ${sub}`);
    void runBridge(values.config);
    return;
  }

  const store = new Store(openDatabase(values.db), { limits: limitsFromEnv() });
  const key = sub && command !== 'serve' && command !== 'list' ? `${command} ${sub}` : command;

  switch (key) {
    case 'serve': {
      const { app } = createApp(store);
      if (process.env.ORCO_TRUST_PROXY) app.set('trust proxy', process.env.ORCO_TRUST_PROXY);
      const port = Number(values.port);
      app.listen(port, values.host, () => {
        console.log(`Orco listening on http://${values.host}:${port}`);
        console.log(`  MCP endpoint: http://${values.host}:${port}/mcp`);
        if (values.host !== '127.0.0.1' && values.host !== 'localhost') {
          console.log('  Not bound to localhost: put TLS in front of this (see docs/scope.md).');
        }
      });
      return;
    }
    case 'user add': {
      const [name] = args;
      if (!name) throw new OrcoError('invalid', 'Usage: orco user add <name>');
      const { token } = store.createUser(name);
      console.log(`Created user ${name}. Token (shown once):\n${token}`);
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
