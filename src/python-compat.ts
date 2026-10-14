// Python-semantics helpers for the TypeScript port.
//
// Each helper reproduces one CPython 3.12 behavior the application relies on,
// where the obvious JavaScript equivalent differs (BASELINE.md §8). They are
// checked against tests/equivalence/golden/python-compat.json, which Python
// 3.12 generated before the Python code was removed (migration slice S9); it
// is now a frozen reference.
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

/**
 * Mirrors Python's RecursionError. It is not a ValueError, so `except
 * ValueError` does not catch it (pyJsonLoads on deeply nested input).
 */
export class RecursionError extends Error {
  constructor(message = "maximum recursion depth exceeded") {
    super(message);
    this.name = "RecursionError";
  }
}

/**
 * Mirrors Python's KeyError for a missing mapping key, for example a missing
 * `environment["NOTION_API_KEY"]`. `key` is Python's `error.args[0]`. The
 * message is the key in single quotes, as `str(KeyError("NAME"))` is for a
 * plain name.
 */
export class KeyError extends Error {
  readonly key: string;

  constructor(key: string) {
    super(`'${key}'`);
    this.name = "KeyError";
    this.key = key;
  }
}

// ---------------------------------------------------------------------------
// Exception chaining: `raise error from cause`
// ---------------------------------------------------------------------------
//
// Python code reads the chained cause later (`error.__cause__`). It is stored
// as a non-enumerable `pyCause` property, which Node's util.inspect does not
// print. The standard `cause` option is deliberately not used, because Node
// prints `[cause]` chains for uncaught errors (security invariant S7).
// `raise error from None` is simply `throw error`: there is no cause.

/** `raise error from cause`: `throw withPyCause(error, cause)`. Returns `error`. */
export function withPyCause<E extends Error>(error: E, cause: unknown): E {
  Object.defineProperty(error, "pyCause", {
    value: cause,
    enumerable: false,
    writable: false,
    configurable: true,
  });
  return error;
}

/** `error.__cause__`: the cause set by withPyCause, or null (None) when there is none. */
export function getPyCause(error: unknown): unknown {
  if (typeof error === "object" && error !== null && Object.hasOwn(error, "pyCause")) {
    return (error as { pyCause: unknown }).pyCause;
  }
  return null;
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

/**
 * The body of a regex character class (for a `u`-flag RegExp) that matches
 * exactly what Python's `re` `\s` matches in a str pattern: the code points
 * for which str.isspace() is true (golden "regex_space"). The characters are
 * inserted literally; none of them is special inside a class.
 */
export const PY_RE_SPACE_CLASS = String.fromCodePoint(...PY_SPACE_CODE_POINTS);

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

// The line boundaries of Python 3.12 `str.splitlines()`: \n \v \f \r \x1c
// \x1d \x1e \x85 U+2028 U+2029, with \r\n counted as one boundary. All are
// single UTF-16 units, so scanning units cannot split a surrogate pair.
const PY_LINE_BREAK_UNITS = new Set<number>([
  0x0a, 0x0b, 0x0c, 0x0d, 0x1c, 0x1d, 0x1e, 0x85, 0x2028, 0x2029,
]);

/**
 * `s.splitlines()` with no arguments: the line boundaries are dropped, and a
 * trailing boundary does not start an empty final line ("" gives []).
 */
export function pySplitlines(s: string): string[] {
  const lines: string[] = [];
  let start = 0;
  let index = 0;
  while (index < s.length) {
    const unit = s.charCodeAt(index);
    if (PY_LINE_BREAK_UNITS.has(unit)) {
      lines.push(s.slice(start, index));
      index += unit === 0x0d && s.charCodeAt(index + 1) === 0x0a ? 2 : 1;
      start = index;
    } else {
      index += 1;
    }
  }
  if (start < s.length) lines.push(s.slice(start));
  return lines;
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

// ---------------------------------------------------------------------------
// json.loads
// ---------------------------------------------------------------------------

/**
 * The deepest container nesting `json.loads` accepts before it raises
 * RecursionError. CPython 3.12's C scanner enters a C recursion level for each
 * `[` and `{` (Modules/_json.c), and the C recursion limit is platform
 * dependent (Include/cpython/pystate.h: 10000 on Linux, 3000 on Windows).
 * On Windows, `py -3.12` accepts 2997 nested containers and rejects 2998: the
 * json.loads call path itself uses 3 levels. The reference is CI (Linux), so
 * this is 10000 - 3. Assumption: the call path uses the same 3 levels there.
 * The golden table only records depths on which both platforms agree.
 */
export const PY_JSON_MAX_DEPTH = 9997;

/** Python's default `sys.get_int_max_str_digits()`: a longer int literal raises ValueError. */
const PY_INT_MAX_STR_DIGITS = 4300;

const JSON_NUMBER = /-?(?:0|[1-9][0-9]*)(\.[0-9]+)?([eE][-+]?[0-9]+)?/y;
const JSON_HEX4 = /^[0-9a-fA-F]{4}$/;

const JSON_SIMPLE_ESCAPES: Readonly<Record<string, string>> = {
  '"': '"',
  "/": "/",
  b: "\b",
  f: "\f",
  n: "\n",
  r: "\r",
  t: "\t",
};

function jsonDecodeError(what: string): ValueError {
  // json.JSONDecodeError is a ValueError. The message never quotes the input.
  return new ValueError(`JSONDecodeError: ${what}`);
}

/**
 * Sets a JSON object member the way a dict assignment does: a repeated key
 * keeps its first position and takes the last value. defineProperty, unlike
 * `obj[key] = value`, also stores "__proto__" as an ordinary own key, as
 * JSON.parse does.
 */
function setMember(target: Dict, key: string, value: JsonValue): void {
  Object.defineProperty(target, key, { value, enumerable: true, writable: true, configurable: true });
}

type OpenContainer =
  | { readonly kind: "array"; readonly value: JsonValue[] }
  | { readonly kind: "object"; readonly value: { [key: string]: JsonValue }; key: string };

class PyJsonScanner {
  readonly #s: string;
  #i = 0;

  constructor(s: string) {
    this.#s = s;
  }

  // json.decoder.WHITESPACE: only space, \t, \n and \r.
  #skipWhitespace(): void {
    const s = this.#s;
    while (this.#i < s.length) {
      const ch = s[this.#i];
      if (ch !== " " && ch !== "\t" && ch !== "\n" && ch !== "\r") return;
      this.#i += 1;
    }
  }

  // py_scanstring / scanstring_unicode with strict=True. Each \uXXXX escape
  // is appended as its UTF-16 unit, so an escaped surrogate pair becomes the
  // pair (Python joins it into one code point, which a JS string represents
  // the same way) and an unpaired escaped surrogate stays a lone surrogate.
  #scanString(): string {
    const s = this.#s;
    let out = "";
    let j = this.#i + 1;
    for (;;) {
      if (j >= s.length) throw jsonDecodeError("Unterminated string");
      const unit = s.charCodeAt(j);
      if (unit === 0x22) {
        this.#i = j + 1;
        return out;
      }
      if (unit === 0x5c) {
        const escape = s[j + 1];
        if (escape === undefined) throw jsonDecodeError("Unterminated string");
        if (escape === "u") {
          const hex = s.slice(j + 2, j + 6);
          if (!JSON_HEX4.test(hex)) throw jsonDecodeError("Invalid \\uXXXX escape");
          out += String.fromCharCode(parseInt(hex, 16));
          j += 6;
        } else if (escape === String.fromCharCode(0x5c)) {
          out += escape;
          j += 2;
        } else if (Object.hasOwn(JSON_SIMPLE_ESCAPES, escape)) {
          out += JSON_SIMPLE_ESCAPES[escape] as string;
          j += 2;
        } else {
          throw jsonDecodeError("Invalid escape");
        }
        continue;
      }
      if (unit < 0x20) throw jsonDecodeError("Invalid control character");
      out += s[j];
      j += 1;
    }
  }

  // A scalar at the current position, or null when the position opens a
  // container (the caller handles those). Throws "Expecting value" otherwise.
  #scanScalar(): { value: JsonValue } | null {
    const s = this.#s;
    const i = this.#i;
    const ch = s[i];
    if (ch === '"') return { value: this.#scanString() };
    if (ch === "{" || ch === "[") return null;
    const constants: Array<[string, JsonValue]> = [
      ["null", null],
      ["true", true],
      ["false", false],
      ["NaN", NaN],
      ["Infinity", Infinity],
      ["-Infinity", -Infinity],
    ];
    for (const [text, value] of constants) {
      if (s.startsWith(text, i)) {
        this.#i = i + text.length;
        return { value };
      }
    }
    JSON_NUMBER.lastIndex = i;
    const match = JSON_NUMBER.exec(s);
    if (!match) throw jsonDecodeError("Expecting value");
    const text = match[0];
    this.#i = i + text.length;
    if (match[1] !== undefined || match[2] !== undefined) {
      // float(text): JS and Python both round correctly, and overflow to ±inf.
      return { value: Number(text) };
    }
    // int(text). JS numbers lose precision beyond 2**53; no caller depends on it.
    const digits = text.startsWith("-") ? text.length - 1 : text.length;
    if (digits > PY_INT_MAX_STR_DIGITS) {
      throw new ValueError("Exceeds the limit (4300 digits) for integer string conversion");
    }
    const value = Number(text);
    return { value: Object.is(value, -0) ? 0 : value };
  }

  // The member name after `{` or `,`, and the `:` after it.
  #scanMemberName(): string {
    if (this.#s[this.#i] !== '"') {
      throw jsonDecodeError("Expecting property name enclosed in double quotes");
    }
    const key = this.#scanString();
    this.#skipWhitespace();
    if (this.#s[this.#i] !== ":") throw jsonDecodeError("Expecting ':' delimiter");
    this.#i += 1;
    this.#skipWhitespace();
    return key;
  }

  // scan_once, iteratively: nesting depth is limited by PY_JSON_MAX_DEPTH
  // (RecursionError, as in Python), not by the JS call stack.
  scanDocument(): JsonValue {
    const s = this.#s;
    const open: OpenContainer[] = [];
    this.#skipWhitespace();
    for (;;) {
      // Scan one value: a scalar, an empty container, or the start of a
      // container whose first member is scanned next.
      let value: JsonValue;
      const scalar = this.#scanScalar();
      if (scalar !== null) {
        value = scalar.value;
      } else {
        if (open.length + 1 > PY_JSON_MAX_DEPTH) {
          throw new RecursionError("maximum recursion depth exceeded while decoding a JSON document");
        }
        const isObject = s[this.#i] === "{";
        this.#i += 1;
        this.#skipWhitespace();
        if (isObject) {
          if (s[this.#i] === "}") {
            this.#i += 1;
            value = {};
          } else {
            open.push({ kind: "object", value: {}, key: this.#scanMemberName() });
            continue;
          }
        } else if (s[this.#i] === "]") {
          this.#i += 1;
          value = [];
        } else {
          open.push({ kind: "array", value: [] });
          continue;
        }
      }

      // Attach the value to the innermost open container, closing every
      // container that ends here, until one expects another member.
      for (;;) {
        const container = open.at(-1);
        if (container === undefined) return value;
        if (container.kind === "array") {
          container.value.push(value);
        } else {
          setMember(container.value, container.key, value);
        }
        this.#skipWhitespace();
        const close = container.kind === "array" ? "]" : "}";
        if (s[this.#i] === close) {
          this.#i += 1;
          open.pop();
          value = container.value;
          continue;
        }
        if (s[this.#i] !== ",") throw jsonDecodeError("Expecting ',' delimiter");
        this.#i += 1;
        this.#skipWhitespace();
        if (container.kind === "object") container.key = this.#scanMemberName();
        break;
      }
    }
  }

  get position(): number {
    return this.#i;
  }

  skipTrailingWhitespace(): void {
    this.#skipWhitespace();
  }
}

/**
 * `json.loads(s)` for a str, as in CPython 3.12 (the C scanner):
 *
 * - Throws ValueError (json.JSONDecodeError) for invalid JSON, including a
 *   leading U+FEFF, any whitespace other than space, \t, \n and \r, trailing
 *   data, raw control characters (U+0000-U+001F) inside strings, and an
 *   unknown escape. U+007F and lone surrogates are allowed in strings.
 * - Accepts NaN, Infinity and -Infinity, which JSON.parse rejects.
 * - Throws ValueError for an int literal of more than 4300 digits.
 * - Throws RecursionError (not a ValueError) for nesting deeper than
 *   PY_JSON_MAX_DEPTH.
 * - A repeated object key keeps its first position and takes the last value.
 *
 * Python ints and floats both become JS numbers, so `1` and `1.0` are the
 * same value here, and an int beyond 2**53 loses precision. Objects are
 * plain objects, so integer-like keys iterate first (as with JSON.parse).
 */
export function pyJsonLoads(s: string): JsonValue {
  if (s.startsWith(String.fromCharCode(0xfeff))) {
    throw jsonDecodeError("Unexpected UTF-8 BOM (decode using utf-8-sig)");
  }
  const scanner = new PyJsonScanner(s);
  const value = scanner.scanDocument();
  scanner.skipTrailingWhitespace();
  if (scanner.position !== s.length) throw jsonDecodeError("Extra data");
  return value;
}

// ---------------------------------------------------------------------------
// Untrusted JSON: Python-semantics accessors
// ---------------------------------------------------------------------------
//
// Notion bodies are untrusted JSON, which the Python code reads with
// `x["key"]`, `x.get(...)`, `for item in x` and truthiness tests inside a
// `try`. These accessors throw where the Python expression raises, so a
// ported parser can catch exactly what its Python counterpart catches:
//
// - KeyError for a missing `x["key"]`;
// - TypeError where Python raises TypeError (`x["key"]` on a list, iterating
//   a number, an unhashable dict key) *or* AttributeError (`.get` on a list or
//   a str). JS has no AttributeError, and a JS property access on null also
//   throws TypeError, so TypeError stands for both.
//
// "Dict" means a JSON object: a non-null, non-array object.

export type Dict = Record<string, unknown>;

/** `isinstance(value, dict)` for a JSON value. */
export function isDict(value: unknown): value is Dict {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Python truthiness of a JSON value: None, False, 0, "", [] and {} are false.
 * NaN (which pyJsonLoads can return) is true, as `bool(float("nan"))` is.
 */
export function truthy(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "object") return Object.keys(value).length > 0;
  if (typeof value === "number") return value !== 0;
  return Boolean(value);
}

/** `value[key]` for a str key: TypeError on a non-dict, KeyError when the key is missing. */
export function subscript(value: unknown, key: string): unknown {
  if (!isDict(value)) throw new TypeError("object is not subscriptable by str");
  if (!Object.hasOwn(value, key)) throw new KeyError(key);
  return value[key];
}

/** `value.get(key, fallback)` (fallback defaults to None); AttributeError (here TypeError) on a non-dict. */
export function dictGet(value: unknown, key: string, fallback: unknown = null): unknown {
  if (!isDict(value)) throw new TypeError("object has no attribute 'get'");
  return Object.hasOwn(value, key) ? value[key] : fallback;
}

/** `key in value` for a dict and a str key. */
export function dictContains(value: Dict, key: string): boolean {
  return Object.hasOwn(value, key);
}

/** `iter(value)`: a list's items, a str's characters (code points) or a dict's keys; TypeError otherwise. */
export function iterate(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (typeof value === "string") return Array.from(value);
  if (isDict(value)) return Object.keys(value);
  throw new TypeError("object is not iterable");
}

/** Python raises TypeError when a list or dict is used as a dict key or set member. */
export function assertHashable(value: unknown): void {
  if (typeof value === "object" && value !== null) throw new TypeError("unhashable type");
}

/** `except (AttributeError, KeyError, TypeError)` for errors from the accessors above. */
export function isAccessError(error: unknown): boolean {
  return error instanceof TypeError || error instanceof KeyError;
}

/** `except (AttributeError, KeyError, TypeError, ValueError)`: isAccessError plus ValueError. */
export function isParseError(error: unknown): boolean {
  return isAccessError(error) || error instanceof ValueError;
}
