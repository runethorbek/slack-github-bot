// Python-semantics helpers for the TypeScript port.
//
// Each helper reproduces one CPython 3.12 behavior the application relies on,
// where the obvious JavaScript equivalent differs (BASELINE.md §8). They are
// checked against tests/equivalence/golden/python-compat.json, which Python
// 3.12 generates (tests/equivalence/generate_python_compat_golden.py).
//
// Strings are treated as sequences of code points, as Python does. A JS string
// can hold a lone surrogate; it counts as one code point, which is also what
// Python does with a lone surrogate.

/** Mirrors Python's ValueError, so ported `except ValueError` logic translates directly. */
export class ValueError extends Error {
  constructor(message = "ValueError") {
    super(message);
    this.name = "ValueError";
  }
}

/** Mirrors Python's OverflowError (for example `date + timedelta` out of range). */
export class OverflowError extends Error {
  constructor(message = "OverflowError") {
    super(message);
    this.name = "OverflowError";
  }
}

// ---------------------------------------------------------------------------
// Code points, length, slicing, comparison
// ---------------------------------------------------------------------------

function codePoints(s: string): string[] {
  return Array.from(s);
}

/** `len(s)`: the number of code points, not UTF-16 units. */
export function pyLen(s: string): number {
  let count = 0;
  for (const _ of s) count += 1;
  return count;
}

/** `s[start:stop]` with Python's code-point indexing and negative-index rules. */
export function pySlice(s: string, start?: number, stop?: number): string {
  // Array.prototype.slice clamps and treats negative indexes the same way
  // Python slicing does for a step of 1.
  return codePoints(s).slice(start, stop).join("");
}

/**
 * The repository's truncation pattern:
 *
 *     if len(text) <= LIMIT: return text
 *     return text[: LIMIT - len(suffix)] + suffix
 *
 * measured in code points.
 */
export function pyTruncate(s: string, limit: number, suffix: string): string {
  if (pyLen(s) <= limit) return s;
  return pySlice(s, 0, limit - pyLen(suffix)) + suffix;
}

/**
 * Python `str` ordering: lexicographic by code point. JS `<` compares UTF-16
 * units, which orders astral characters before U+E000–U+FFFF.
 * Returns -1, 0 or 1.
 */
export function comparePy(a: string, b: string): number {
  if (a === b) return 0;
  const left = a[Symbol.iterator]();
  const right = b[Symbol.iterator]();
  for (;;) {
    const x = left.next();
    const y = right.next();
    if (x.done) return y.done ? 0 : -1;
    if (y.done) return 1;
    const cx = x.value.codePointAt(0) as number;
    const cy = y.value.codePointAt(0) as number;
    if (cx !== cy) return cx < cy ? -1 : 1;
  }
}

// ---------------------------------------------------------------------------
// Whitespace
// ---------------------------------------------------------------------------

// Every code point for which Python 3.12 `str.isspace()` is true. It differs
// from JS `\s`: Python includes U+001C–U+001F and U+0085, and excludes U+FEFF.
const PY_SPACE_CODE_POINTS = new Set<number>([
  0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x1c, 0x1d, 0x1e, 0x1f, 0x20, 0x85, 0xa0, 0x1680,
  0x2000, 0x2001, 0x2002, 0x2003, 0x2004, 0x2005, 0x2006, 0x2007, 0x2008, 0x2009,
  0x200a, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000,
]);

/** `ch.isspace()` for a single code point. An empty string returns false, as in Python. */
export function pyIsSpace(ch: string): boolean {
  if (ch === "") return false;
  for (const c of ch) {
    if (!PY_SPACE_CODE_POINTS.has(c.codePointAt(0) as number)) return false;
  }
  return true;
}

/** `s[0].isspace()`, for a non-empty string (Python raises IndexError on an empty one). */
export function pyStartsWithSpace(s: string): boolean {
  if (s === "") throw new Error("IndexError: string index out of range");
  const first = s.codePointAt(0) as number;
  return PY_SPACE_CODE_POINTS.has(first);
}

/** `s.strip()` with no arguments. */
export function pyStrip(s: string): string {
  const chars = codePoints(s);
  let start = 0;
  let end = chars.length;
  while (start < end && pyIsSpace(chars[start] as string)) start += 1;
  while (end > start && pyIsSpace(chars[end - 1] as string)) end -= 1;
  return chars.slice(start, end).join("");
}

/** `s.split()` with no arguments: split on runs of whitespace, no empty strings. */
export function pySplitWhitespace(s: string): string[] {
  const parts: string[] = [];
  let current = "";
  let inWord = false;
  for (const ch of s) {
    if (pyIsSpace(ch)) {
      if (inWord) parts.push(current);
      current = "";
      inWord = false;
    } else {
      current += ch;
      inWord = true;
    }
  }
  if (inWord) parts.push(current);
  return parts;
}

// ---------------------------------------------------------------------------
// casefold
// ---------------------------------------------------------------------------

/**
 * `str.casefold()`.
 *
 * Python case folding is context-free and per code point, so each code point
 * is folded on its own as lower → upper → lower. Folding per code point avoids
 * the final-sigma rule that `toLowerCase` applies to a whole string (Python
 * folds `ς` to `σ`). The round trip makes `ẞ` and `ß` become `ss`.
 *
 * Explicit fixes, from an exhaustive comparison with Python 3.12:
 * - `ı` (U+0131) has no folding in Python, but the round trip gives `i`.
 * - Cherokee folds to the *uppercase* letters (U+13A0–U+13F5), the opposite
 *   direction of the JS round trip.
 *
 * Known gap: Node's ICU uses a newer Unicode version than Python 3.12
 * (Unicode 15.0). Code points that were unassigned in Unicode 15.0 but have
 * case mappings in Node (for example U+A7CB, U+1C89, U+10D50) are folded here
 * and left unchanged by Python 3.12. For every code point assigned in Unicode
 * 15.0 the result matches; the golden table checks that exhaustively.
 * The same applies to pyFloat/pyInt: decimal-digit recognition follows
 * Node's ICU Unicode version, so digits added after Unicode 15.0 parse in TS
 * but not in Python 3.12 (negligible).
 */
export function casefold(s: string): string {
  let out = "";
  for (const ch of s) {
    out += casefoldCodePoint(ch);
  }
  return out;
}

function casefoldCodePoint(ch: string): string {
  const cp = ch.codePointAt(0) as number;
  if (cp < 0x80) {
    return cp >= 0x41 && cp <= 0x5a ? String.fromCharCode(cp + 0x20) : ch;
  }
  if (cp === 0x0131) return ch;
  if (cp >= 0x13a0 && cp <= 0x13f5) return ch;
  if (cp >= 0x13f8 && cp <= 0x13fd) return String.fromCodePoint(cp - 8);
  if (cp >= 0xab70 && cp <= 0xabbf) return String.fromCodePoint(cp - 0xab70 + 0x13a0);
  if (cp >= 0xd800 && cp <= 0xdfff) return ch;
  return ch.toLowerCase().toUpperCase().toLowerCase();
}

// ---------------------------------------------------------------------------
// Numbers from strings: float() and int()
// ---------------------------------------------------------------------------

const DECIMAL_DIGIT = /^\p{Nd}$/u;

// The decimal value of a Unicode Nd code point. Unicode guarantees Nd digits
// come in contiguous runs of whole 0–9 sequences, so the value is the offset
// from the start of the run, modulo 10.
function decimalValue(cp: number): number {
  if (cp >= 0x30 && cp <= 0x39) return cp - 0x30;
  if (!DECIMAL_DIGIT.test(String.fromCodePoint(cp))) return -1;
  let start = cp;
  while (DECIMAL_DIGIT.test(String.fromCodePoint(start - 1))) start -= 1;
  return (cp - start) % 10;
}

// CPython's _PyUnicode_TransformDecimalAndSpaceToASCII, followed by stripping
// ASCII whitespace (Py_ISSPACE), as float() and int() do before parsing.
// Returns null where CPython would fail on a non-ASCII, non-digit character.
function asciiNumberText(s: string): string | null {
  let out = "";
  for (const ch of s) {
    const cp = ch.codePointAt(0) as number;
    if (cp < 127) {
      out += ch;
    } else if (PY_SPACE_CODE_POINTS.has(cp)) {
      out += " ";
    } else {
      const digit = decimalValue(cp);
      if (digit < 0) return null;
      out += String.fromCharCode(0x30 + digit);
    }
  }
  return out.replace(/^[ \t\n\r\v\f]+/, "").replace(/[ \t\n\r\v\f]+$/, "");
}

const FLOAT_PATTERN = /^[+-]?(?:\d(?:_?\d)*(?:\.(?:\d(?:_?\d)*)?)?|\.\d(?:_?\d)*)(?:[eE][+-]?\d(?:_?\d)*)?$/;
const INF_NAN_PATTERN = /^([+-]?)(inf|infinity|nan)$/i;

/**
 * `float(s)` for a string. Accepts surrounding whitespace, underscores between
 * digits, `inf`/`infinity`/`nan` in any case with an optional sign, exponents,
 * and Unicode decimal digits. Throws ValueError otherwise (including for "").
 */
export function pyFloat(s: string): number {
  const text = asciiNumberText(s);
  if (text === null) throw new ValueError("could not convert string to float");
  const special = INF_NAN_PATTERN.exec(text);
  if (special) {
    if ((special[2] as string).toLowerCase() === "nan") return NaN;
    return special[1] === "-" ? -Infinity : Infinity;
  }
  if (!FLOAT_PATTERN.test(text)) throw new ValueError("could not convert string to float");
  return Number(text.replaceAll("_", ""));
}

const INT_PATTERN = /^[+-]?\d(?:_?\d)*$/;

/**
 * `int(s)` for a string in base 10. Values beyond 2**53 lose precision; the
 * callers only use small values and range-check them afterwards.
 */
export function pyInt(s: string): number {
  const text = asciiNumberText(s);
  if (text === null || !INT_PATTERN.test(text)) {
    throw new ValueError("invalid literal for int() with base 10");
  }
  const value = Number(text.replaceAll("_", ""));
  return Object.is(value, -0) ? 0 : value;
}

// ---------------------------------------------------------------------------
// json.dumps
// ---------------------------------------------------------------------------

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

function hex4(unit: number): string {
  return unit.toString(16).padStart(4, "0");
}

// json.encoder.py_encode_basestring_ascii: escape `"` and `\`, use the short
// escapes for \n \r \t \b \f, and \uXXXX (lowercase hex) for everything else
// outside U+0020–U+007E. Astral characters become surrogate-pair escapes,
// which is what iterating UTF-16 units produces directly.
function encodeString(s: string): string {
  let out = '"';
  for (let i = 0; i < s.length; i += 1) {
    const unit = s.charCodeAt(i);
    const ch = s[i] as string;
    if (ch === '"') out += '\\"';
    else if (ch === "\\") out += "\\\\";
    else if (ch === "\n") out += "\\n";
    else if (ch === "\r") out += "\\r";
    else if (ch === "\t") out += "\\t";
    else if (ch === "\b") out += "\\b";
    else if (ch === "\f") out += "\\f";
    else if (unit < 0x20 || unit > 0x7e) out += `\\u${hex4(unit)}`;
    else out += ch;
  }
  return `${out}"`;
}

// float.__repr__: the shortest round-trip digits, in fixed notation when the
// decimal exponent is in [-4, 16), otherwise as d.ddde±XX (at least 2 digits).
function pyFloatRepr(value: number): string {
  const [mantissa, exponentText] = value.toExponential().split("e") as [string, string];
  const exponent = Number(exponentText);
  const negative = mantissa.startsWith("-");
  const digits = mantissa.replace("-", "").replace(".", "");
  let body: string;
  if (exponent >= -4 && exponent < 16) {
    if (exponent < 0) {
      body = `0.${"0".repeat(-exponent - 1)}${digits}`;
    } else if (digits.length <= exponent + 1) {
      body = `${digits}${"0".repeat(exponent + 1 - digits.length)}.0`;
    } else {
      body = `${digits.slice(0, exponent + 1)}.${digits.slice(exponent + 1)}`;
    }
  } else {
    const fraction = digits.length > 1 ? `.${digits.slice(1)}` : "";
    const sign = exponent < 0 ? "-" : "+";
    body = `${digits[0]}${fraction}e${sign}${String(Math.abs(exponent)).padStart(2, "0")}`;
  }
  return negative ? `-${body}` : body;
}

function encodeNumber(value: number): string {
  if (Number.isNaN(value)) return "NaN";
  if (value === Infinity) return "Infinity";
  if (value === -Infinity) return "-Infinity";
  // JS has one number type. An integral value is written the way Python
  // writes an int ("3", not "3.0"), since the values the application
  // serializes are ints in Python.
  if (Number.isInteger(value)) return BigInt(value).toString();
  return pyFloatRepr(value);
}

function encodeValue(value: unknown): string {
  if (value === null) return "null";
  if (value === true) return "true";
  if (value === false) return "false";
  if (typeof value === "number") return encodeNumber(value);
  if (typeof value === "string") return encodeString(value);
  if (Array.isArray(value)) {
    return `[${value.map((item: unknown) => encodeValue(item)).join(", ")}]`;
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).map(
      ([key, item]) => `${encodeString(key)}: ${encodeValue(item)}`,
    );
    return `{${entries.join(", ")}}`;
  }
  throw new TypeError(`Object of type ${typeof value} is not JSON serializable`);
}

/**
 * `json.dumps(value)` with Python's defaults: `", "` and `": "` separators,
 * `ensure_ascii=True`, `allow_nan=True`, keys in insertion order.
 *
 * Differences that come from JS itself: integral numbers are written as
 * Python ints, and objects with integer-like keys ("1") iterate those keys
 * first, so their order can differ from the order they were written in.
 */
export function pyJsonDumps(value: JsonValue): string {
  return encodeValue(value);
}
