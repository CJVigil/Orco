#!/usr/bin/env node
// Orco plugin hooks (#102). SessionStart: a short my_work summary (what waits on this agent, and the
// handoff of each ticket it has in progress). UserPromptSubmit and PostToolUse: one line when new
// mentions or answers arrived since the last check, nothing otherwise. Fast and silent when Orco is
// down. Uses the server and token the plugin already stores (CLAUDE_PLUGIN_OPTION_*), no new secrets.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const base = (process.env.CLAUDE_PLUGIN_OPTION_SERVER_URL || process.env.ORCO_URL || '').replace(/\/+$/, '');
const token = process.env.CLAUDE_PLUGIN_OPTION_TOKEN || process.env.ORCO_TOKEN || '';
const dataDir = process.env.CLAUDE_PLUGIN_DATA || join(process.env.HOME || process.env.USERPROFILE || '.', '.orco');
const stateFile = join(dataDir, 'hook-state.json');
// PostToolUse fires after every tool: look at most this often there.
const TOOL_EVERY_MS = 20_000;
// The link to this session (#105): a Claude Code session on the web has one; ORCO_SESSION_URL overrides.
const remote = process.env.CLAUDE_CODE_REMOTE_SESSION_ID || '';
const sessionUrl = process.env.ORCO_SESSION_URL || (remote ? `https://claude.ai/code/session_${remote.replace(/^cse_/, '')}` : '');
// Orco tools that take session_url, by their name without the plugin prefix.
const SESSION_TOOLS = /(?:^|__)(comment_ticket|update_ticket|update_task)$/;

async function main() {
  if (!base || !token) return;
  let input = {};
  try {
    input = JSON.parse(readFileSync(0, 'utf8') || '{}');
  } catch {
    // No hook input: treat it as a prompt.
  }
  const event = input.hook_event_name || process.argv[2] || 'UserPromptSubmit';
  const state = readState();
  const session = input.session_id || 'default';
  const mine = state[session] ?? {};

  if (event === 'PreToolUse') {
    // Fill in session_url on Orco writes, so a comment links back to the session that wrote it.
    const name = input.tool_name || '';
    if (!sessionUrl || !SESSION_TOOLS.test(name) || !input.tool_input || input.tool_input.session_url) return;
    if (name.endsWith('update_task') && !['done', 'failed'].includes(input.tool_input.state)) return;
    process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', updatedInput: { ...input.tool_input, session_url: sessionUrl } } }));
    return;
  }
  if (event === 'SessionStart') {
    const text = await get('/api/my-work?format=brief', 'text');
    const now = new Date().toISOString();
    save(state, session, { cursor: now, checked: Date.now() });
    const link = sessionUrl ? `\nThis session's link: ${sessionUrl} (pass it as session_url when you comment on or hand off a ticket).` : '';
    if (text || link) emit(event, `${text ?? ''}${link}`.trim());
    return;
  }
  if (event === 'PostToolUse' && mine.checked && Date.now() - mine.checked < TOOL_EVERY_MS) return;
  const cursor = mine.cursor || new Date(Date.now() - 60_000).toISOString();
  const activity = await get(`/api/activity?after=${encodeURIComponent(cursor)}`, 'json');
  if (!activity) return;
  save(state, session, { cursor: activity.now || cursor, checked: Date.now() });
  const parts = [];
  if (activity.mentions?.length) parts.push(`${activity.mentions.length} new mention${activity.mentions.length === 1 ? '' : 's'} (${[...new Set(activity.mentions.map((m) => `${m.author} in #${m.room}`))].slice(0, 3).join(', ')})`);
  const tickets = [...new Set((activity.answers ?? []).map((a) => a.ref))];
  if (tickets.length) parts.push(`${activity.answers.length} answer${activity.answers.length === 1 ? '' : 's'} on ${tickets.slice(0, 3).join(', ')}`);
  if (parts.length) emit(event, `Orco: ${parts.join(', ')}. Read them with my_work or wait_for_mentions.`);
}

async function get(path, kind) {
  try {
    const res = await fetch(`${base}${path}`, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(900) });
    if (!res.ok) return null;
    return kind === 'text' ? (await res.text()).trim() : await res.json();
  } catch {
    return null;
  }
}

function emit(event, text) {
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: event, additionalContext: text } }));
}

function readState() {
  try {
    return JSON.parse(readFileSync(stateFile, 'utf8'));
  } catch {
    return {};
  }
}

function save(state, session, value) {
  try {
    mkdirSync(dataDir, { recursive: true });
    // Keep the 20 most recent sessions.
    const entries = Object.entries({ ...state, [session]: value }).sort(([, a], [, b]) => (b.checked ?? 0) - (a.checked ?? 0)).slice(0, 20);
    writeFileSync(stateFile, JSON.stringify(Object.fromEntries(entries)), { mode: 0o600 });
  } catch {
    // A read-only data folder: the next check repeats this one.
  }
}

main().catch(() => {}).finally(() => process.exit(0));
