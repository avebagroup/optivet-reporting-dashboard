/**
 * tz.js - date arithmetic in the sub-account's timezone, with no dependencies.
 *
 * Every "day" on the dashboard is a local day in that timezone (OptiVet is
 * America/New_York), so a text sent at 11pm Eastern lands on the right day.
 */

const fmtCache = new Map();
function fmt(tz) {
  if (!fmtCache.has(tz)) {
    fmtCache.set(
      tz,
      new Intl.DateTimeFormat('en-US', {
        timeZone: tz,
        hourCycle: 'h23',
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit',
      }),
    );
  }
  return fmtCache.get(tz);
}

export function isValidTimezone(tz) {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** Wall-clock parts of a UTC instant in the given timezone. */
export function partsInTz(ms, tz) {
  const p = {};
  for (const { type, value } of fmt(tz).formatToParts(new Date(ms))) {
    if (type !== 'literal') p[type] = Number(value);
  }
  return { y: p.year, m: p.month, d: p.day, h: p.hour === 24 ? 0 : p.hour, mi: p.minute, s: p.second };
}

/** "YYYY-MM-DD" of a UTC instant, in the timezone. */
export function dayKey(ms, tz) {
  const { y, m, d } = partsInTz(ms, tz);
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/** UTC ms of a local wall-clock time in the timezone. Handles DST shifts. */
export function zonedToUtc(y, m, d, h = 0, mi = 0, s = 0, tz) {
  const wanted = Date.UTC(y, m - 1, d, h, mi, s);
  let guess = wanted;
  for (let i = 0; i < 3; i++) {
    const p = partsInTz(guess, tz);
    const got = Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi, p.s);
    const diff = wanted - got;
    if (diff === 0) break;
    guess += diff;
  }
  return guess;
}

export function parseDay(str) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(str || ''));
  if (!m) return null;
  const y = Number(m[1]), mo = Number(m[2]), d = Number(m[3]);
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  return { y, m: mo, d };
}

/** Inclusive local-day range -> [startMs, endMs] in UTC. */
export function dayRangeToUtc(fromDay, toDay, tz) {
  const a = parseDay(fromDay), b = parseDay(toDay);
  if (!a || !b) throw new Error('Dates must be YYYY-MM-DD');
  const startMs = zonedToUtc(a.y, a.m, a.d, 0, 0, 0, tz);
  // End = start of the day after `to`, minus one millisecond.
  const next = new Date(Date.UTC(b.y, b.m - 1, b.d + 1));
  const endMs = zonedToUtc(next.getUTCFullYear(), next.getUTCMonth() + 1, next.getUTCDate(), 0, 0, 0, tz) - 1;
  if (endMs < startMs) throw new Error('"to" is before "from"');
  return { startMs, endMs };
}

/** Every local day key from `from` to `to` inclusive. */
export function listDays(fromDay, toDay) {
  const a = parseDay(fromDay), b = parseDay(toDay);
  const out = [];
  let cur = Date.UTC(a.y, a.m - 1, a.d);
  const end = Date.UTC(b.y, b.m - 1, b.d);
  while (cur <= end && out.length < 400) {
    out.push(new Date(cur).toISOString().slice(0, 10));
    cur += 86400000;
  }
  return out;
}

export function todayKey(tz, offsetDays = 0) {
  return dayKey(Date.now() + offsetDays * 86400000, tz);
}

/** Presets resolved in the timezone. */
export function presetRange(name, tz) {
  const today = todayKey(tz);
  switch (name) {
    case 'yesterday': {
      const y = todayKey(tz, -1);
      return { from: y, to: y };
    }
    case 'last7': return { from: todayKey(tz, -6), to: today };
    case 'month': return { from: today.slice(0, 8) + '01', to: today };
    case 'today':
    default: return { from: today, to: today };
  }
}
