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
} else if (FAKE_MODE === 'hang') {
  setInterval(() => {}, 1000);
} else {
  await call(`/tasks/${ORCO_TASK_ID}`, { state: 'accepted' });
  const note = FAKE_MODE === 'args' ? JSON.stringify(process.argv.slice(2)) : `fake agent finished task ${ORCO_TASK_ID}`;
  await call(`/tasks/${ORCO_TASK_ID}`, { state: 'done', note });
}
