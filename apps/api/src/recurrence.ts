export type RecurrenceRule = {
  frequency: 'daily' | 'weekdays' | 'weekly' | 'monthly';
  weekdays?: number[];
  dayOfMonth?: number;
  localTime: string;
  timezone: string;
  startAt: string;
  endAt?: string | null;
};

type LocalParts = { year: number; month: number; day: number; hour: number; minute: number; weekday: number };
const formatter = (timezone: string) => new Intl.DateTimeFormat('en-US', {
  timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  hourCycle: 'h23', weekday: 'short'
});
const weekdays = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export function validTimezone(timezone: string) {
  try { formatter(timezone).format(0); return true; } catch { return false; }
}

function localParts(date: Date, timezone: string): LocalParts {
  const parts = Object.fromEntries(formatter(timezone).formatToParts(date).map((part) => [part.type, part.value]));
  return { year: +parts.year, month: +parts.month, day: +parts.day, hour: +parts.hour, minute: +parts.minute, weekday: weekdays.indexOf(parts.weekday) };
}

function localToUtc(year: number, month: number, day: number, hour: number, minute: number, timezone: string): Date | null {
  const guess = Date.UTC(year, month - 1, day, hour, minute);
  let candidate = guess;
  for (let attempt = 0; attempt < 3; attempt++) {
    const value = localParts(new Date(candidate), timezone);
    const rendered = Date.UTC(value.year, value.month - 1, value.day, value.hour, value.minute);
    candidate += guess - rendered;
  }
  const value = localParts(new Date(candidate), timezone);
  return value.year === year && value.month === month && value.day === day && value.hour === hour && value.minute === minute
    ? new Date(candidate) : null;
}

const localDate = (year: number, month: number, day: number) => new Date(Date.UTC(year, month - 1, day));

export function nextOccurrence(rule: RecurrenceRule, after: Date): Date | null {
  if (!validTimezone(rule.timezone) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(rule.localTime)) return null;
  const start = new Date(rule.startAt);
  const end = rule.endAt ? new Date(rule.endAt) : null;
  const floor = after >= start ? after : new Date(start.getTime() - 1);
  const local = localParts(floor, rule.timezone);
  const [hour, minute] = rule.localTime.split(':').map(Number);
  for (let offset = 0; offset <= 370; offset++) {
    const date = localDate(local.year, local.month, local.day + offset);
    const year = date.getUTCFullYear(), month = date.getUTCMonth() + 1, day = date.getUTCDate(), weekday = date.getUTCDay();
    const matches = rule.frequency === 'daily'
      || rule.frequency === 'weekdays' && (rule.weekdays ?? []).includes(weekday)
      || rule.frequency === 'weekly' && weekday === (rule.weekdays?.[0] ?? localParts(start, rule.timezone).weekday)
      || rule.frequency === 'monthly' && day === rule.dayOfMonth;
    if (!matches) continue;
    const candidate = localToUtc(year, month, day, hour, minute, rule.timezone);
    if (candidate && candidate > floor && candidate >= start && (!end || candidate <= end)) return candidate;
  }
  return null;
}
