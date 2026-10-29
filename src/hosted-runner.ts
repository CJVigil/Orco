import { Bridge, DEFAULT_PROMPT, type Logger } from './bridge/bridge.js';
import type { BridgeAgentConfig } from './bridge/config.js';
import type { Store } from './store.js';

const KEY_ENV = 'ORCO_HOSTED_MODEL_KEY';

/**
 * Runs the agents that live on Orco itself (see hosted.ts): one bridge per agent, inside the server
 * process, talking to Orco over loopback like any other bridge. Each agent gets a fresh token when it
 * starts, held only in memory (Orco still stores only its hash), so nobody ever sees or copies it.
 * The model calls go to the provider an org admin configured, and nowhere else.
 */
export class HostedRunner {
  private readonly bridges = new Map<string, Bridge>();
  private stopped = false;
  /** Restarts in flight, so changes made quickly one after another apply in order. */
  private chain: Promise<void> = Promise.resolve();

  constructor(
    private readonly store: Store,
    /** How this process reaches its own HTTP server, like http://127.0.0.1:7420. */
    private readonly server: string,
    private readonly log: Logger,
  ) {}

  async start(): Promise<void> {
    this.store.hosted.onChange = (agent) => {
      this.chain = this.chain.then(() => this.restart(agent)).catch((err: Error) => this.log.error(`[hosted ${agent}] ${err.message}`));
    };
    for (const run of this.store.hosted.runs()) await this.restart(run.name);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.store.hosted.onChange = () => {};
    await this.chain;
    await Promise.all([...this.bridges.values()].map((bridge) => bridge.stop()));
    this.bridges.clear();
  }

  get running(): string[] {
    return [...this.bridges.keys()].sort();
  }

  /** (Re)starts one agent with its current settings, or stops it if it no longer runs here. */
  private async restart(name: string): Promise<void> {
    await this.bridges.get(name)?.stop();
    this.bridges.delete(name);
    const agent = this.store.participantByName(name);
    const run = agent ? this.store.hosted.runFor(agent.id) : null;
    if (this.stopped || !run) return;
    const token = this.store.rotateToken(name);
    const tokenEnv = `ORCO_TOKEN_${name.toUpperCase().replace(/-/g, '_')}`;
    const config: BridgeAgentConfig = {
      name,
      token_env: tokenEnv,
      command: [],
      lifecycle: 'agent',
      model: {
        base_url: run.baseUrl,
        name: run.model,
        api_key_env: run.apiKey ? KEY_ENV : undefined,
        max_turns: 30,
        tools: run.tools,
        price: run.price,
      },
      prompt_template: run.prompt ? `${run.prompt}\n\n${DEFAULT_PROMPT}` : DEFAULT_PROMPT,
      timeout_seconds: 900,
      max_concurrent: 1,
      task_tokens: true,
      retry_minutes: 30,
      run_logs: true,
    };
    const bridge = new Bridge(
      { server: this.server, agents: [config] },
      {
        env: { [tokenEnv]: token, ...(run.apiKey ? { [KEY_ENV]: run.apiKey } : {}) },
        logger: { info: (m) => this.log.info(`hosted ${m}`), error: (m) => this.log.error(`hosted ${m}`) },
        echoOutput: false,
      },
    );
    await bridge.start();
    this.bridges.set(name, bridge);
    this.log.info(`hosted agent ${name} is running on ${new URL(run.baseUrl).host} (${run.model})`);
  }
}
