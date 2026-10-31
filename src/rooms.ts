import { OrcoError } from './errors.js';

const SEGMENT = /^(\*|[a-z0-9][a-z0-9-]{0,31})$/;
const MAX_PATTERNS = 20;

/**
 * Matches room names against patterns, like MQTT topic filters: a room is "lobby" (server-wide) or
 * "project/room", and `*` stands for one whole part: "ops/*" is every room in ops, a `*` project with
 * the room "alerts" is every project's alerts room, "*" alone is every server-wide room.
 */
export interface RoomMatcher {
  room(name: string): boolean;
  /** Whether some room of this project (null: a server-wide room) could match. */
  project(name: string | null): boolean;
  patterns: string[];
}

export function roomMatcher(raw: string | string[]): RoomMatcher {
  const patterns = (Array.isArray(raw) ? raw : raw.split(','))
    .map((p) => p.trim().toLowerCase().replace(/^#/, ''))
    .filter(Boolean);
  if (patterns.length === 0 || patterns.length > MAX_PATTERNS) throw new OrcoError('invalid', `Give 1 to ${MAX_PATTERNS} room patterns, like ops/* or */alerts`);
  const parsed = patterns.map((p) => {
    const parts = p.split('/');
    if (parts.length > 2 || !parts.every((s) => SEGMENT.test(s))) throw new OrcoError('invalid', `${p} is not a room pattern; use names and *, like ops/* or */alerts`);
    return parts;
  });
  const fits = (part: string, value: string) => part === '*' || part === value;
  return {
    patterns,
    room: (name) => {
      const parts = name.split('/');
      return parsed.some((p) => p.length === parts.length && p.every((part, i) => fits(part, parts[i]!)));
    },
    project: (name) => parsed.some((p) => (name === null ? p.length === 1 : p.length === 2 && fits(p[0]!, name))),
  };
}
