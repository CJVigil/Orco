import { parseArgs } from 'node:util';
import { openDatabase } from './db.js';
import { createApp } from './http.js';
import { OrcoError, Store } from './store.js';

const USAGE = `Usage: orco-server <command> [options]

Commands:
  serve                      Start the server
  user add <name>            Create a user and print their token
  agent add <owner> <name>   Create an agent owned by a user and print its token
  token rotate <name>        Replace a user's or agent's token and print the new one
  list                       List users and agents

Options:
  --db <path>     SQLite file (env ORCO_DB, default ./orco.db)
  --host <host>   Address to listen on (env ORCO_HOST, default 127.0.0.1)
  --port <port>   Port to listen on (env ORCO_PORT, default 7420)
`;

export function main(): void {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      db: { type: 'string', default: process.env.ORCO_DB ?? './orco.db' },
      host: { type: 'string', default: process.env.ORCO_HOST ?? '127.0.0.1' },
      port: { type: 'string', default: process.env.ORCO_PORT ?? '7420' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  const [command, sub, ...args] = positionals;
  if (values.help || !command) {
    process.stdout.write(USAGE);
    return;
  }

  const store = new Store(openDatabase(values.db));
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
      if (!name) throw new OrcoError('invalid', 'Usage: orco-server user add <name>');
      const { token } = store.createUser(name);
      console.log(`Created user ${name}. Token (shown once):\n${token}`);
      return;
    }
    case 'agent add': {
      const [owner, name] = args;
      if (!owner || !name) throw new OrcoError('invalid', 'Usage: orco-server agent add <owner> <name>');
      const { token } = store.createAgent(owner, name);
      console.log(`Created agent ${name} owned by ${owner}. Token (shown once):\n${token}`);
      return;
    }
    case 'token rotate': {
      const [name] = args;
      if (!name) throw new OrcoError('invalid', 'Usage: orco-server token rotate <name>');
      console.log(`New token for ${name} (shown once):\n${store.rotateToken(name)}`);
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
