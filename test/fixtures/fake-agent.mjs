const { ORCO_URL, ORCO_TASK_ID, FAKE_TOKEN, FAKE_MODE } = process.env;

async function call(path, body) {
  const res = await fetch(`${ORCO_URL}/api${path}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${FAKE_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${path}: ${res.status} ${await res.text()}`);
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
} else if (FAKE_MODE === 'hang') {
  setInterval(() => {}, 1000);
} else {
  await call(`/tasks/${ORCO_TASK_ID}`, { state: 'accepted' });
  const note = FAKE_MODE === 'args' ? JSON.stringify(process.argv.slice(2)) : `fake agent finished task ${ORCO_TASK_ID}`;
  await call(`/tasks/${ORCO_TASK_ID}`, { state: 'done', note });
}
