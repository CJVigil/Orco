const { ORCO_URL, ORCO_TASK_ID, BOT_TOKEN, FAKE_MODE } = process.env;

async function call(path, body) {
  const res = await fetch(`${ORCO_URL}/api${path}`, {
    method: body ? 'POST' : 'GET',
    headers: { Authorization: `Bearer ${BOT_TOKEN}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`${path}: ${res.status} ${await res.text()}`);
  return res.json().catch(() => null);
}

if (FAKE_MODE === 'crash') {
  console.error('fake agent crashing on purpose');
  process.exit(3);
}
if (FAKE_MODE === 'ask') {
  // First run: accept and ask. Second run (resumed): the prompt carries the answer; finish with it.
  const prompt = process.argv[2] ?? '';
  const answer = /Reply from \S+: (.*)/.exec(prompt)?.[1];
  if (answer) {
    await call(`/tasks/${ORCO_TASK_ID}`, { state: 'done', note: `resumed with: ${answer}` });
  } else {
    await call(`/tasks/${ORCO_TASK_ID}`, { state: 'accepted' });
    await call(`/tasks/${ORCO_TASK_ID}/questions`, { question: 'staging or prod?' });
  }
} else if (FAKE_MODE === 'scope') {
  // Report which token the bridge handed over and what it can see.
  await call(`/tasks/${ORCO_TASK_ID}`, { state: 'accepted' });
  const projects = (await call('/projects')).map((p) => p.name);
  await call(`/tasks/${ORCO_TASK_ID}`, { state: 'done', note: JSON.stringify({ prefix: BOT_TOKEN.slice(0, 7), projects }) });
} else if (FAKE_MODE === 'remind') {
  // First run: accept and ask to be woken. Second run (the reminder): finish with the note it got.
  const prompt = process.argv[2] ?? '';
  const note = /Your note:\n(.*)/.exec(prompt)?.[1];
  if (note) {
    await call(`/tasks/${ORCO_TASK_ID}`, { state: 'done', note: `woken with: ${note}` });
  } else {
    await call(`/tasks/${ORCO_TASK_ID}`, { state: 'accepted' });
    await call(`/tasks/${ORCO_TASK_ID}/reminders`, { in_minutes: 1, note: 'check CI' });
  }
} else if (FAKE_MODE === 'plain') {
  // A tool that cannot reach Orco: it prints a summary and exits; the bridge closes the task.
  console.log('Edited 2 files: src/a.ts, src/b.ts');
} else if (FAKE_MODE === 'plain-fail') {
  console.error('model quota exceeded');
  process.exit(4);
} else if (FAKE_MODE === 'mcpconfig') {
  // Reads the private MCP config the bridge wrote for this run, and reports what it saw.
  const { readFileSync } = await import('node:fs');
  const config = JSON.parse(readFileSync(process.argv[4], 'utf8'));
  const auth = config.mcpServers.orco.headers.Authorization;
  await call(`/tasks/${ORCO_TASK_ID}`, { state: 'accepted' });
  await call(`/tasks/${ORCO_TASK_ID}`, { state: 'done', note: JSON.stringify({ url: config.mcpServers.orco.url, task: auth.startsWith('Bearer orco_t_'), path: process.argv[4], cli: process.env.ORCO_TOKEN === auth.slice(7) }) });
} else if (FAKE_MODE === 'stream') {
  // Talks like claude -p --output-format stream-json; prints its token once, which the log must hide.
  const out = (event) => console.log(JSON.stringify(event));
  out({ type: 'system', subtype: 'init', model: 'fake-model' });
  out({ type: 'assistant', message: { content: [{ type: 'text', text: `Working with ${BOT_TOKEN}` }, { type: 'tool_use', name: 'mcp__orco__update_task', input: { state: 'accepted' } }] } });
  await call(`/tasks/${ORCO_TASK_ID}`, { state: 'accepted' });
  out({ type: 'user', message: { content: [{ type: 'tool_result', content: 'accepted' }] } });
  await call(`/tasks/${ORCO_TASK_ID}`, { state: 'done', note: 'streamed' });
  out({ type: 'result', subtype: 'success', num_turns: 2, total_cost_usd: 0.1234, usage: { input_tokens: 100, cache_read_input_tokens: 900, output_tokens: 40 } });
} else if (FAKE_MODE === 'worktree' || FAKE_MODE === 'worktree-idle' || FAKE_MODE === 'worktree-dirty') {
  // Reports where it runs; in 'worktree' mode it also commits a file there.
  const { writeFileSync } = await import('node:fs');
  const { execFileSync } = await import('node:child_process');
  await call(`/tasks/${ORCO_TASK_ID}`, { state: 'accepted' });
  if (FAKE_MODE === 'worktree') {
    writeFileSync('work.txt', `task ${ORCO_TASK_ID}\n`);
    execFileSync('git', ['add', 'work.txt']);
    execFileSync('git', ['-c', 'user.name=Fake', '-c', 'user.email=fake@example.invalid', 'commit', '-q', '-m', `Task ${ORCO_TASK_ID}`]);
  }
  if (FAKE_MODE === 'worktree-dirty') writeFileSync('half-done.txt', 'not committed\n');
  const branch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { encoding: 'utf8' }).trim();
  await call(`/tasks/${ORCO_TASK_ID}`, {
    state: 'done',
    note: JSON.stringify({ cwd: process.cwd(), branch, envBranch: process.env.ORCO_BRANCH, told: (process.argv[2] ?? '').includes('git worktree made for this task') }),
  });
} else if (FAKE_MODE === 'limited') {
  // Starts, saves its place, then the tool runs out of usage the way Claude Code reports it.
  await call(`/tasks/${ORCO_TASK_ID}`, { state: 'accepted' });
  await call(`/tasks/${ORCO_TASK_ID}/checkpoint`, { text: 'done: read the code; next: write the fix' });
  console.log('Working on the rate limiter for the API'); // the work itself may mention limits
  console.error("You've hit your usage limit · resets 3pm");
  process.exit(1);
} else if (FAKE_MODE === 'hang') {
  setInterval(() => {}, 1000);
} else {
  await call(`/tasks/${ORCO_TASK_ID}`, { state: 'accepted' });
  const note = FAKE_MODE === 'args' ? JSON.stringify(process.argv.slice(2)) : `fake agent finished task ${ORCO_TASK_ID}`;
  await call(`/tasks/${ORCO_TASK_ID}`, { state: 'done', note });
}
