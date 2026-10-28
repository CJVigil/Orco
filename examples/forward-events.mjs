#!/usr/bin/env node
// Forwards the Orco events that need you (mentions, questions, approvals, flags from your agents)
// to a chat or push service you choose. The Orco server never calls out; you run this yourself,
// anywhere that can reach both Orco and the service.
//
//   ORCO_URL=https://orco.example.internal ORCO_TOKEN=<your user token> \
//   FORWARD_URL=https://ntfy.sh/<your-topic> FORWARD_FORMAT=text node forward-events.mjs
//
// FORWARD_FORMAT=json (the default) posts {"text": "..."}, which Slack, Mattermost and Discord-style
// (use FORWARD_FORMAT=discord for {"content": "..."}) incoming webhooks accept. text posts the line
// as a plain body, which suits ntfy. Needs Node 22 or newer; no dependencies.

const { ORCO_URL, ORCO_TOKEN, FORWARD_URL, FORWARD_FORMAT = 'json' } = process.env;
if (!ORCO_URL || !ORCO_TOKEN || !FORWARD_URL) {
  console.error('Set ORCO_URL, ORCO_TOKEN (a user token) and FORWARD_URL.');
  process.exit(1);
}
const base = ORCO_URL.replace(/\/$/, '');
const headers = { Authorization: `Bearer ${ORCO_TOKEN}` };

async function forward(line) {
  const body =
    FORWARD_FORMAT === 'text' ? line : JSON.stringify(FORWARD_FORMAT === 'discord' ? { content: line } : { text: line });
  const type = FORWARD_FORMAT === 'text' ? 'text/plain' : 'application/json';
  try {
    const res = await fetch(FORWARD_URL, { method: 'POST', headers: { 'Content-Type': type }, body });
    if (!res.ok) console.error(`Forward failed: ${res.status}`);
  } catch (err) {
    console.error(`Forward failed: ${err.message}`);
  }
}

const clip = (text) => (text.length > 300 ? `${text.slice(0, 297)}…` : text);
const seen = new Set();

function handle(me, event, data) {
  if (event === 'message') {
    if (seen.has(data.id) || data.author === me || !data.mentions.includes(me)) return;
    seen.add(data.id);
    const what = data.approval ? 'needs your approval' : data.question ? 'asks you' : 'mentioned you';
    void forward(`${data.author} ${what} in #${data.room}: ${clip(data.text)}`);
  } else if (event === 'flag') {
    void forward('One of your agents flagged something for you. Open the Orco Inbox.');
  }
}

async function run() {
  const me = await fetch(`${base}/api/me`, { headers }).then((r) => {
    if (!r.ok) throw new Error(`Orco said ${r.status}; check ORCO_URL and ORCO_TOKEN`);
    return r.json();
  });
  const res = await fetch(`${base}/api/events`, { headers });
  if (!res.ok || !res.body) throw new Error(`Event stream failed: ${res.status}`);
  console.log(`Forwarding events for ${me.name}`);
  let buffer = '';
  for await (const chunk of res.body.pipeThrough(new TextDecoderStream())) {
    buffer += chunk;
    let end;
    while ((end = buffer.indexOf('\n\n')) !== -1) {
      const block = buffer.slice(0, end);
      buffer = buffer.slice(end + 2);
      const event = /^event: (.*)$/m.exec(block)?.[1];
      const data = /^data: (.*)$/m.exec(block)?.[1];
      if (event && data) handle(me.name, event, JSON.parse(data));
    }
  }
}

// Reconnect after a dropped connection or a server restart.
for (;;) {
  try {
    await run();
    console.error('Event stream ended; reconnecting');
  } catch (err) {
    console.error(err.message);
  }
  await new Promise((resolve) => setTimeout(resolve, 5_000));
}
