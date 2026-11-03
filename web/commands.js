// Slash commands for the composer and a ticket's comment box (#93). Pure functions, no DOM: the app
// runs what parseCommand returns. A message that only starts like a path ("/tmp is full") is not a
// command: only the names below are.

export const COMMANDS = [
  { name: 'task', usage: '/task @agent what you need', hint: 'Give an agent a task', where: 'room' },
  { name: 'ticket', usage: '/ticket "title"', hint: 'File a ticket in this project', where: 'any' },
  { name: 'assign', usage: '/assign @someone', hint: 'Assign the open ticket (none to unassign)', where: 'ticket' },
  { name: 'next', usage: '/next "the next step"', hint: "Set the open ticket's next step", where: 'ticket' },
  { name: 'waiting', usage: '/waiting @person "what you need"', hint: 'Ask a person to do something on the open ticket', where: 'ticket' },
  { name: 'done', usage: '/done', hint: 'Move the open ticket to Done', where: 'ticket' },
  { name: 'search', usage: '/search words', hint: 'Search messages, tickets, notes and tasks', where: 'any' },
];

const NAME = /^\/([a-z]+)(?:\s+([\s\S]*))?$/;
const PERSON = /^@?([a-z0-9][a-z0-9-]{0,31})$/;
const PERSON_THEN = /^@?([a-z0-9][a-z0-9-]{0,31})\s+([\s\S]+)$/;

/** Text without one pair of surrounding quotes, straight or curly. */
export function unquote(text) {
  const t = text.trim();
  const m = /^(["“”'‘’])([\s\S]*)(["“”'‘’])$/.exec(t);
  return m ? m[2].trim() : t;
}

/**
 * What a typed command asks for, or null when the text is not a command. A command with missing or
 * wrong arguments comes back with `error`, saying how to use it.
 */
export function parseCommand(text) {
  const m = NAME.exec(String(text ?? '').trim());
  if (!m) return null;
  const command = COMMANDS.find((c) => c.name === m[1]);
  if (!command) return null;
  const args = (m[2] ?? '').trim();
  const usage = { name: command.name, error: `Use ${command.usage}` };
  switch (command.name) {
    case 'task':
      return { name: 'task', text: String(text).trim() };
    case 'ticket':
      return unquote(args) ? { name: 'ticket', title: unquote(args) } : usage;
    case 'assign': {
      if (/^(none|nobody|-)$/i.test(args)) return { name: 'assign', who: null };
      const who = PERSON.exec(args);
      return who ? { name: 'assign', who: who[1] } : usage;
    }
    case 'next':
      return unquote(args) ? { name: 'next', text: unquote(args) } : usage;
    case 'waiting': {
      const w = PERSON_THEN.exec(args);
      return w && unquote(w[2]) ? { name: 'waiting', who: w[1], ask: unquote(w[2]) } : usage;
    }
    case 'done':
      return args ? usage : { name: 'done' };
    case 'search':
      return args ? { name: 'search', query: args } : usage;
  }
  return null;
}

/** The commands that fit where the person is typing, matching what they typed after "/". */
export function commandSuggestions(typed, where) {
  const prefix = typed.replace(/^\//, '').toLowerCase();
  return COMMANDS.filter((c) => (c.where === 'any' || c.where === where || (where === 'room' && c.where === 'ticket')) && c.name.startsWith(prefix));
}
