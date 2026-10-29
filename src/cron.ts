import { OrcoError } from './errors.js';

/** A parsed five-field cron expression: minute hour day-of-month month day-of-week. */
export interface Cron {
  minutes: Set<number>;
  hours: Set<number>;
  days: Set<number>;
  months: Set<number>;
  weekdays: Set<number>;
  /** Day of month and day of week both restricted: either may match, as in classic cron. */
  eitherDay: boolean;
}

const MACROS: Record<string, string> = {
  '@hourly': '0 * * * *',
  '@daily': '0 0 * * *',
  '@weekly': '0 0 * * 0',
  '@monthly': '0 0 1 * *',
  '@yearly': '0 0 1 1 *',
};
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const WEEKDAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const HORIZON_MS = 5 * 366 * 86_400_000;

function field(text: string, min: number, max: number, names: string[] = [], nameBase = 0): Set<number> {
  const values = new Set<number>();
  const value = (raw: string) => {
    const named = names.indexOf(raw.toLowerCase());
    const n = named >= 0 ? named + nameBase : Number(raw);
    if (!Number.isInteger(n) || n < min || n > max) throw new OrcoError('invalid', `${raw} is not between ${min} and ${max}`);
    return n;
  };
  for (const part of text.split(',')) {
    const [range, stepText] = part.split('/');
    const step = stepText === undefined ? 1 : Number(stepText);
    if (!Number.isInteger(step) || step < 1) throw new OrcoError('invalid', `Bad step in ${part}`);
    let from: number;
    let to: number;
    if (range === '*') {
      from = min;
      to = max;
    } else if (range!.includes('-')) {
      const [a, b] = range!.split('-');
      from = value(a!);
      to = value(b!);
      if (to < from) throw new OrcoError('invalid', `Backwards range ${range}`);
    } else {
      from = value(range!);
      to = stepText === undefined ? from : max;
    }
    for (let n = from; n <= to; n += step) values.add(n);
  }
  return values;
}

export function parseCron(expression: string): Cron {
  const text = (MACROS[expression.trim().toLowerCase()] ?? expression).trim();
  const parts = text.split(/\s+/);
  if (parts.length !== 5) throw new OrcoError('invalid', 'A schedule is five fields: minute hour day-of-month month day-of-week, like "0 9 * * 1-5"');
  const [minute, hour, day, month, weekday] = parts as [string, string, string, string, string];
  const weekdays = field(weekday, 0, 7, WEEKDAYS);
  if (weekdays.delete(7)) weekdays.add(0);
  return {
    minutes: field(minute, 0, 59),
    hours: field(hour, 0, 23),
    days: field(day, 1, 31),
    months: field(month, 1, 12, MONTHS, 1),
    weekdays,
    eitherDay: day !== '*' && weekday !== '*',
  };
}

export function checkTimeZone(tz: string): string {
  try {
    return new Intl.DateTimeFormat('en-US', { timeZone: tz }).resolvedOptions().timeZone;
  } catch {
    throw new OrcoError('invalid', `Unknown time zone ${tz}; use a name like America/Chicago or UTC`);
  }
}

/**
 * The first minute after `afterMs` that matches, in the given time zone. When clocks go back, the
 * repeated hour runs once (the first time); when they go forward, times in the skipped hour do not
 * run that day.
 */
export function nextRun(cron: Cron, afterMs: number, tz = 'UTC'): number {
  const format = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hourCycle: 'h23',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    weekday: 'short',
  });
  const local = (t: number) => {
    const parts: Record<string, string> = {};
    for (const p of format.formatToParts(t)) parts[p.type] = p.value;
    return {
      month: Number(parts.month),
      day: Number(parts.day),
      hour: Number(parts.hour),
      minute: Number(parts.minute),
      weekday: WEEKDAYS.indexOf(parts.weekday!.toLowerCase().slice(0, 3)),
    };
  };
  // The second pass through a wall-clock time when clocks go back (by an hour, or half an hour).
  const repeated = (t: number) => {
    const now = local(t);
    return [30, 60].some((back) => {
      const before = local(t - back * 60_000);
      return before.month === now.month && before.day === now.day && before.hour === now.hour && before.minute === now.minute;
    });
  };
  let t = Math.floor(afterMs / 60_000) * 60_000 + 60_000;
  const end = afterMs + HORIZON_MS;
  while (t < end) {
    const { month, day, hour, minute, weekday } = local(t);
    const dayOk = cron.eitherDay ? cron.days.has(day) || cron.weekdays.has(weekday) : cron.days.has(day) && cron.weekdays.has(weekday);
    if (!cron.months.has(month) || !dayOk) {
      t += ((23 - hour) * 60 + (60 - minute)) * 60_000;
    } else if (!cron.hours.has(hour)) {
      t += (60 - minute) * 60_000;
    } else if (!cron.minutes.has(minute)) {
      t += 60_000;
    } else if (repeated(t)) {
      t += 60_000;
    } else {
      return t;
    }
  }
  throw new OrcoError('invalid', 'That schedule never runs');
}
