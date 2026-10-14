// A timezone-free calendar date, matching Python's `datetime.date`, plus the
// Python 3.12 parsers the application uses on date strings.
//
// Representation: a validated `YYYY-MM-DD` string (years 0001–9999), branded
// so that only this module creates one. This was chosen over an object because:
// - it is `date.isoformat()` already, and serializes as itself;
// - `===`, `<` and `<=` compare correctly, because zero-padded ISO strings with
//   four-digit years order chronologically. Ported `date <= today` checks and
//   tuple sort keys keep their shape;
// - a string is immutable, and there are no Date objects or timezones involved.

import { OverflowError, ValueError, pyInt, pySplitWhitespace } from "./python-compat.ts";

declare const plainDateBrand: unique symbol;

export type PlainDate = string & { readonly [plainDateBrand]: true };

const MIN_YEAR = 1;
const MAX_YEAR = 9999;
const DAYS_BEFORE_MONTH = [0, 0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334];

function isLeap(year: number): boolean {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

/** `calendar.monthrange(year, month)[1]`. */
export function daysInMonth(year: number, month: number): number {
  if (month === 2) return isLeap(year) ? 29 : 28;
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

function isValidDate(year: number, month: number, day: number): boolean {
  return (
    Number.isInteger(year) &&
    Number.isInteger(month) &&
    Number.isInteger(day) &&
    year >= MIN_YEAR &&
    year <= MAX_YEAR &&
    month >= 1 &&
    month <= 12 &&
    day >= 1 &&
    day <= daysInMonth(year, month)
  );
}

function format(year: number, month: number, day: number): PlainDate {
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}` as PlainDate;
}

/** `date(year, month, day)`: throws ValueError for an invalid date. */
export function makeDate(year: number, month: number, day: number): PlainDate {
  if (!isValidDate(year, month, day)) throw new ValueError("invalid date");
  return format(year, month, day);
}

/** The `year`, `month` and `day` attributes. */
export function dateParts(value: PlainDate): { year: number; month: number; day: number } {
  return {
    year: Number(value.slice(0, 4)),
    month: Number(value.slice(5, 7)),
    day: Number(value.slice(8, 10)),
  };
}

/** `date.isoformat()`. */
export function isoformat(value: PlainDate): string {
  return value;
}

/** Three-way comparison, -1 / 0 / 1. Plain `<`, `<=` and `===` work as well. */
export function compareDates(a: PlainDate, b: PlainDate): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function datesEqual(a: PlainDate, b: PlainDate): boolean {
  return a === b;
}

/** `date.max`, usable in sort keys. */
export const DATE_MAX = format(MAX_YEAR, 12, 31);

/** `date.min`. */
export const DATE_MIN = format(MIN_YEAR, 1, 1);

// Proleptic Gregorian ordinal, where 0001-01-01 is day 1 (date.toordinal()).
function toOrdinal(year: number, month: number, day: number): number {
  const y = year - 1;
  const daysBeforeYear = y * 365 + Math.floor(y / 4) - Math.floor(y / 100) + Math.floor(y / 400);
  const leapDay = month > 2 && isLeap(year) ? 1 : 0;
  return daysBeforeYear + (DAYS_BEFORE_MONTH[month] as number) + leapDay + day;
}

// date.fromordinal(). Returns the parts without range-checking the year.
function fromOrdinal(ordinal: number): { year: number; month: number; day: number } {
  let n = ordinal - 1;
  const n400 = Math.floor(n / 146097);
  n -= n400 * 146097;
  const n100 = Math.floor(n / 36524);
  n -= n100 * 36524;
  const n4 = Math.floor(n / 1461);
  n -= n4 * 1461;
  const n1 = Math.floor(n / 365);
  n -= n1 * 365;
  let year = n400 * 400 + n100 * 100 + n4 * 4 + n1 + 1;
  if (n1 === 4 || n100 === 4) {
    return { year: year - 1, month: 12, day: 31 };
  }
  let month = 1;
  for (;;) {
    const length = daysInMonth(year, month);
    if (n < length) break;
    n -= length;
    month += 1;
  }
  return { year, month, day: n + 1 };
}

/** `value + timedelta(days=days)`: throws OverflowError outside 0001–9999. */
export function addDays(value: PlainDate, days: number): PlainDate {
  const { year, month, day } = dateParts(value);
  const result = fromOrdinal(toOrdinal(year, month, day) + days);
  if (result.year < MIN_YEAR || result.year > MAX_YEAR) {
    throw new OverflowError("date value out of range");
  }
  return format(result.year, result.month, result.day);
}

/**
 * `people_due.add_calendar_months`:
 *
 *     month_index = value.month - 1 + months
 *     year = value.year + month_index // 12
 *     month = month_index % 12 + 1
 *     day = min(value.day, monthrange(year, month)[1])
 *     return date(year, month, day)
 *
 * `//` and `%` are Python's floor division and modulo.
 */
export function addCalendarMonths(value: PlainDate, months: number): PlainDate {
  const parts = dateParts(value);
  const monthIndex = parts.month - 1 + months;
  const year = parts.year + Math.floor(monthIndex / 12);
  const month = monthIndex - Math.floor(monthIndex / 12) * 12 + 1;
  if (year < MIN_YEAR || year > MAX_YEAR) throw new ValueError("year is out of range");
  const day = Math.min(parts.day, daysInMonth(year, month));
  return makeDate(year, month, day);
}

// ---------------------------------------------------------------------------
// date.fromisoformat / datetime.fromisoformat (CPython 3.12 C implementation)
// ---------------------------------------------------------------------------
//
// These are line-by-line ports of Modules/_datetimemodule.c at v3.12.10. The C
// code works on the UTF-8 bytes of the string and relies on the terminating
// NUL byte, so `byteAt` returns 0 at and beyond the end. Lengths are in UTF-8
// bytes. The C code does not always check that the whole string was consumed;
// that leniency (for example `date.fromisoformat("20261013xy")`) is kept.

const textEncoder = new TextEncoder();

function hasLoneSurrogate(s: string): boolean {
  return /\p{Surrogate}/u.test(s);
}

function byteAt(bytes: Uint8Array, index: number): number {
  return index >= 0 && index < bytes.length ? (bytes[index] as number) : 0;
}

const CH_0 = 0x30;
const CH_DASH = 0x2d;
const CH_W = 0x57;
const CH_Z = 0x5a;
const CH_PLUS = 0x2b;
const CH_COLON = 0x3a;
const CH_DOT = 0x2e;
const CH_COMMA = 0x2c;

function isDigitByte(b: number): boolean {
  return b >= CH_0 && b <= CH_0 + 9;
}

// parse_digits: returns [newPosition, value] or null.
function parseDigits(bytes: Uint8Array, pos: number, count: number): [number, number] | null {
  let value = 0;
  for (let i = 0; i < count; i += 1) {
    const b = byteAt(bytes, pos);
    pos += 1;
    if (!isDigitByte(b)) return null;
    value = value * 10 + (b - CH_0);
  }
  return [pos, value];
}

type DateFields = { year: number; month: number; day: number };

function weekdayOfJan1(year: number): number {
  // 0 = Monday, as in the C helper weekday().
  return (toOrdinal(year, 1, 1) + 6) % 7;
}

function isoWeek1Monday(year: number): number {
  const firstDay = toOrdinal(year, 1, 1);
  const firstWeekday = (firstDay + 6) % 7;
  let week1Monday = firstDay - firstWeekday;
  if (firstWeekday > 3) week1Monday += 7;
  return week1Monday;
}

// iso_to_ymd: returns the fields, or null for every failure code.
function isoToYmd(isoYear: number, isoWeek: number, isoDay: number): DateFields | null {
  if (isoYear < MIN_YEAR || isoYear > MAX_YEAR) return null;
  if (isoWeek <= 0 || isoWeek >= 53) {
    let outOfRange = true;
    if (isoWeek === 53) {
      const firstWeekday = weekdayOfJan1(isoYear);
      if (firstWeekday === 3 || (firstWeekday === 2 && isLeap(isoYear))) outOfRange = false;
    }
    if (outOfRange) return null;
  }
  if (isoDay <= 0 || isoDay >= 8) return null;
  const day1 = isoWeek1Monday(isoYear);
  const dayOffset = (isoWeek - 1) * 7 + isoDay - 1;
  return fromOrdinal(day1 + dayOffset);
}

// parse_isoformat_date: `len` is compared as the C size_t parameter.
function parseIsoformatDate(bytes: Uint8Array, len: number): DateFields | null {
  let pos = 0;
  const yearResult = parseDigits(bytes, pos, 4);
  if (yearResult === null) return null;
  let year: number;
  [pos, year] = yearResult;

  const usesSeparator = byteAt(bytes, pos) === CH_DASH;
  if (usesSeparator) pos += 1;

  if (byteAt(bytes, pos) === CH_W) {
    pos += 1;
    const weekResult = parseDigits(bytes, pos, 2);
    if (weekResult === null) return null;
    let isoWeek: number;
    [pos, isoWeek] = weekResult;
    let isoDay: number;
    if (pos < len) {
      if (usesSeparator) {
        const separator = byteAt(bytes, pos);
        pos += 1;
        if (separator !== CH_DASH) return null;
      }
      const dayResult = parseDigits(bytes, pos, 1);
      if (dayResult === null) return null;
      [pos, isoDay] = dayResult;
    } else {
      isoDay = 1;
    }
    return isoToYmd(year, isoWeek, isoDay);
  }

  const monthResult = parseDigits(bytes, pos, 2);
  if (monthResult === null) return null;
  let month: number;
  [pos, month] = monthResult;
  if (usesSeparator) {
    const separator = byteAt(bytes, pos);
    pos += 1;
    if (separator !== CH_DASH) return null;
  }
  const dayResult = parseDigits(bytes, pos, 2);
  if (dayResult === null) return null;
  return { year, month, day: dayResult[1] };
}

/**
 * `date.fromisoformat(s)` as in Python 3.12: `YYYY-MM-DD`, `YYYYMMDD`,
 * `YYYY-Www`, `YYYYWww`, `YYYY-Www-D` and `YYYYWwwD`. Throws ValueError
 * otherwise. The error message never contains the input.
 */
export function dateFromIsoformat(s: string): PlainDate {
  if (hasLoneSurrogate(s)) throw new ValueError("Invalid isoformat string");
  const bytes = textEncoder.encode(s);
  const len = bytes.length;
  const fields = len === 7 || len === 8 || len === 10 ? parseIsoformatDate(bytes, len) : null;
  if (fields === null) throw new ValueError("Invalid isoformat string");
  return makeDate(fields.year, fields.month, fields.day);
}

// _find_isoformat_datetime_separator
function findDatetimeSeparator(bytes: Uint8Array, len: number): number {
  if (len === 7) return 7;
  if (byteAt(bytes, 4) === CH_DASH) {
    if (byteAt(bytes, 5) === CH_W) {
      if (len < 8) return -1;
      if (len > 8 && byteAt(bytes, 8) === CH_DASH) {
        if (len === 9) return -1;
        if (len > 10 && isDigitByte(byteAt(bytes, 10))) return 8;
        return 10;
      }
      return 8;
    }
    return 10;
  }
  if (byteAt(bytes, 4) === CH_W) {
    let idx = 7;
    for (; idx < len; idx += 1) {
      if (!isDigitByte(byteAt(bytes, idx))) break;
    }
    if (idx < 9) return idx;
    return idx % 2 === 0 ? 7 : 8;
  }
  return 8;
}

type TimeFields = { hour: number; minute: number; second: number; microsecond: number };

// parse_hh_mm_ss_ff: returns [returnCode, fields]; codes as in C (0, 1, -3, -4).
function parseHhMmSsFf(bytes: Uint8Array, start: number, end: number): [number, TimeFields] {
  const values = [0, 0, 0];
  let microsecond = 0;
  let pos = start;
  let hasSeparator = true;
  const fields = (): TimeFields => ({
    hour: values[0] as number,
    minute: values[1] as number,
    second: values[2] as number,
    microsecond,
  });

  for (let i = 0; i < 3; i += 1) {
    const result = parseDigits(bytes, pos, 2);
    if (result === null) return [-3, fields()];
    [pos] = result;
    values[i] = result[1];

    const c = byteAt(bytes, pos);
    pos += 1;
    if (i === 0) hasSeparator = c === CH_COLON;

    if (pos >= end) {
      return [c !== 0 ? 1 : 0, fields()];
    } else if (hasSeparator && c === CH_COLON) {
      continue;
    } else if (c === CH_DOT || c === CH_COMMA) {
      break;
    } else if (!hasSeparator) {
      pos -= 1;
    } else {
      return [-4, fields()];
    }
  }
  // Fractional seconds. Every path that reaches this point leaves pos < end,
  // so at least one digit is parsed, as in C.
  const toParse = Math.min(end - pos, 6);
  const fraction = parseDigits(bytes, pos, toParse);
  if (fraction === null) return [-3, fields()];
  [pos, microsecond] = fraction;
  const correction = [100000, 10000, 1000, 100, 10];
  if (toParse < 6) microsecond *= correction[toParse - 1] as number;
  while (isDigitByte(byteAt(bytes, pos))) pos += 1;
  return [byteAt(bytes, pos) !== 0 ? 1 : 0, fields()];
}

type TimeResult = { code: number; time: TimeFields; tzSeconds: number; tzMicroseconds: number };

// parse_isoformat_time
function parseIsoformatTime(bytes: Uint8Array, start: number, len: number): TimeResult {
  const end = start + len;
  let tzPos = start;
  do {
    const b = byteAt(bytes, tzPos);
    if (b === CH_Z || b === CH_PLUS || b === CH_DASH) break;
    tzPos += 1;
  } while (tzPos < end);

  const [rv, time] = parseHhMmSsFf(bytes, start, tzPos);
  if (rv < 0) return { code: rv, time, tzSeconds: 0, tzMicroseconds: 0 };
  if (tzPos === end) {
    return { code: rv === 1 ? -5 : 0, time, tzSeconds: 0, tzMicroseconds: 0 };
  }
  if (byteAt(bytes, tzPos) === CH_Z) {
    return { code: byteAt(bytes, tzPos + 1) !== 0 ? -5 : 1, time, tzSeconds: 0, tzMicroseconds: 0 };
  }
  const tzSign = byteAt(bytes, tzPos) === CH_DASH ? -1 : 1;
  tzPos += 1;
  const [tzRv, tz] = parseHhMmSsFf(bytes, tzPos, end);
  return {
    code: tzRv ? -5 : 1,
    time,
    tzSeconds: tzSign * (tz.hour * 3600 + tz.minute * 60 + tz.second),
    tzMicroseconds: tz.microsecond * tzSign,
  };
}

// Py_UNICODE_IS_SURROGATE at a code-point index, as _sanitize_isoformat_str checks.
function sanitizeIsoformatString(s: string): string | null {
  const chars = Array.from(s);
  if (chars.length < 7) return null;
  for (const position of [7, 8, 10]) {
    if (position > chars.length) break;
    const ch = chars[position];
    if (ch !== undefined && /^\p{Surrogate}$/u.test(ch)) {
      chars[position] = "T";
      return chars.join("");
    }
  }
  return s;
}

/**
 * `datetime.fromisoformat(s.replace("Z", "+00:00")).date()` as in Python 3.12,
 * which is what `people_due.parse_notion_date` falls back to. The result is the
 * date as written in the string, in the string's own offset: it is never
 * converted to UTC or to local time. Throws ValueError for anything Python
 * rejects. The error message never contains the input.
 */
export function dateFromIsoDatetime(s: string): PlainDate {
  const value = s.replaceAll("Z", "+00:00");
  const clean = sanitizeIsoformatString(value);
  if (clean === null || hasLoneSurrogate(clean)) throw new ValueError("Invalid isoformat string");
  const bytes = textEncoder.encode(clean);
  let len = bytes.length;
  const separator = findDatetimeSeparator(bytes, len);

  // The C code passes the separator location as a size_t; -1 becomes huge.
  const dateLength = separator < 0 ? Number.MAX_SAFE_INTEGER : separator;
  const date = parseIsoformatDate(bytes, dateLength);
  let code = date === null ? -1 : 0;
  let time: TimeFields = { hour: 0, minute: 0, second: 0, microsecond: 0 };
  let tzSeconds = 0;
  let tzMicroseconds = 0;

  if (code === 0 && len > separator) {
    let pos = separator;
    const lead = byteAt(bytes, pos);
    if ((lead & 0x80) === 0) pos += 1;
    else if ((lead & 0xf0) === 0xe0) pos += 3;
    else if ((lead & 0xf0) === 0xf0) pos += 4;
    else pos += 2;
    len -= pos;
    const result = parseIsoformatTime(bytes, pos, len);
    code = result.code;
    time = result.time;
    tzSeconds = result.tzSeconds;
    tzMicroseconds = result.tzMicroseconds;
  }
  if (code < 0 || date === null) throw new ValueError("Invalid isoformat string");

  if (code === 1) {
    // timezone(timedelta(seconds=..., microseconds=...)) requires an offset
    // strictly between -24h and +24h.
    const offsetMicroseconds = tzSeconds * 1_000_000 + tzMicroseconds;
    if (Math.abs(offsetMicroseconds) >= 86_400_000_000) {
      throw new ValueError("Invalid isoformat string");
    }
  }
  if (time.hour > 23 || time.minute > 59 || time.second > 59) {
    throw new ValueError("Invalid isoformat string");
  }
  return makeDate(date.year, date.month, date.day);
}

// ---------------------------------------------------------------------------
// Copenhagen "today"
// ---------------------------------------------------------------------------

const copenhagenFormatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Europe/Copenhagen",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

/** `datetime.now(ZoneInfo("Europe/Copenhagen")).date()`; `now` is injectable for tests. */
export function copenhagenToday(now: Date = new Date()): PlainDate {
  const parts = copenhagenFormatter.formatToParts(now);
  const part = (type: string): number =>
    Number(parts.find((candidate) => candidate.type === type)?.value);
  return makeDate(part("year"), part("month"), part("day"));
}

// ---------------------------------------------------------------------------
// HTTP-date (Retry-After)
// ---------------------------------------------------------------------------

const MONTH_NAMES = [
  "jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec",
  "january", "february", "march", "april", "may", "june", "july",
  "august", "september", "october", "november", "december",
];
const DAY_NAMES = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];
const TIMEZONES: Record<string, number> = {
  UT: 0, UTC: 0, GMT: 0, Z: 0,
  AST: -400, ADT: -300,
  EST: -500, EDT: -400,
  CST: -600, CDT: -500,
  MST: -700, MDT: -600,
  PST: -800, PDT: -700,
};

function invalidHttpDate(): never {
  throw new ValueError("Invalid date value or format");
}

// Python's str.isdigit() for a code point; approximated as Unicode Nd (see
// parseHttpDate for the documented gap).
function startsWithDigit(s: string): boolean {
  return /^\p{Nd}/u.test(s);
}

// email._parseaddr._parsedate_tz, line by line. Returns null where Python
// returns None. The last element is the offset in seconds, or null.
function parsedateTz(input: string): [number, number, number, number, number, number, number | null] | null {
  if (!input) return null;
  let data = pySplitWhitespace(input);
  if (data.length === 0) return null;
  const first = data[0] as string;
  if (first.endsWith(",") || DAY_NAMES.includes(first.toLowerCase())) {
    data.splice(0, 1);
  } else {
    const i = first.lastIndexOf(",");
    if (i >= 0) data[0] = first.slice(i + 1);
  }
  if (data.length === 3) {
    const stuff = (data[0] as string).split("-");
    if (stuff.length === 3) data = [...stuff, ...data.slice(1)];
  }
  if (data.length === 4) {
    const s = data[3] as string;
    let i = s.indexOf("+");
    if (i === -1) i = s.indexOf("-");
    if (i > 0) data.splice(3, 1, s.slice(0, i), s.slice(i));
    else data.push("");
  }
  if (data.length < 5) return null;
  data = data.slice(0, 5);
  let [dd, mm, yy, tm, tz] = data as [string, string, string, string, string];
  if (!(dd && mm && yy)) return null;
  mm = mm.toLowerCase();
  if (!MONTH_NAMES.includes(mm)) {
    [dd, mm] = [mm, dd.toLowerCase()];
    if (!MONTH_NAMES.includes(mm)) return null;
  }
  let month = MONTH_NAMES.indexOf(mm) + 1;
  if (month > 12) month -= 12;
  if (dd.endsWith(",")) dd = dd.slice(0, -1);
  if (yy.indexOf(":") > 0) [yy, tm] = [tm, yy];
  if (yy.endsWith(",")) {
    yy = yy.slice(0, -1);
    if (!yy) return null;
  }
  if (!startsWithDigit(yy)) [yy, tz] = [tz, yy];
  if (tm.endsWith(",")) tm = tm.slice(0, -1);
  let timeParts = tm.split(":");
  let thh: string;
  let tmm: string;
  let tss: string;
  if (timeParts.length === 2) {
    [thh, tmm] = timeParts as [string, string];
    tss = "0";
  } else if (timeParts.length === 3) {
    [thh, tmm, tss] = timeParts as [string, string, string];
  } else if (timeParts.length === 1 && (timeParts[0] as string).includes(".")) {
    timeParts = (timeParts[0] as string).split(".");
    if (timeParts.length === 2) {
      [thh, tmm] = timeParts as [string, string];
      tss = "0";
    } else if (timeParts.length === 3) {
      [thh, tmm, tss] = timeParts as [string, string, string];
    } else {
      return null;
    }
  } else {
    return null;
  }
  let year: number;
  let day: number;
  let hour: number;
  let minute: number;
  let second: number;
  try {
    year = pyInt(yy);
    day = pyInt(dd);
    hour = pyInt(thh);
    minute = pyInt(tmm);
    second = pyInt(tss);
  } catch {
    return null;
  }
  if (year < 100) {
    year += year > 68 ? 1900 : 2000;
  }
  let tzOffset: number | null = null;
  tz = tz.toUpperCase();
  if (Object.hasOwn(TIMEZONES, tz)) {
    tzOffset = TIMEZONES[tz] as number;
  } else {
    try {
      tzOffset = pyInt(tz);
    } catch {
      // Python: `except ValueError: pass`
    }
    if (tzOffset === 0 && tz.startsWith("-")) tzOffset = null;
  }
  if (tzOffset) {
    let sign = 1;
    if (tzOffset < 0) {
      sign = -1;
      tzOffset = -tzOffset;
    }
    tzOffset = sign * (Math.floor(tzOffset / 100) * 3600 + (tzOffset % 100) * 60);
  }
  return [year, month, day, hour, minute, second, tzOffset];
}

/**
 * `email.utils.parsedate_to_datetime(s)` followed by the step `retry_delay`
 * applies to it (a naive result is treated as UTC). Returns the instant as
 * epoch milliseconds. Throws ValueError wherever Python raises, which covers
 * Python's ValueError, IndexError and OverflowError cases; `retry_delay`
 * catches all of them alike.
 *
 * Known gap: Python tests `yy[0].isdigit()`, which also accepts non-decimal
 * digits such as `²`; this uses Unicode Nd. Such a string fails to parse in
 * both, except in contrived inputs where the year and zone fields swap.
 */
export function parseHttpDate(s: string): number {
  const parsed = parsedateTz(s);
  if (parsed === null) invalidHttpDate();
  const [year, month, day, hour, minute, second, tzOffset] = parsed;
  if (!isValidDate(year, month, day)) invalidHttpDate();
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59 || second < 0 || second > 59) {
    invalidHttpDate();
  }
  const offset = tzOffset ?? 0;
  if (Math.abs(offset) >= 86_400) invalidHttpDate();
  const days = toOrdinal(year, month, day) - toOrdinal(1970, 1, 1);
  return ((days * 86_400) + hour * 3600 + minute * 60 + second - offset) * 1000;
}
