"""Generate the Python-semantics golden table for src/python-compat.ts and
src/plain-date.ts.

Run with the CI reference Python (3.12):

    py -3.12 tests/equivalence/generate_python_compat_golden.py          # write
    py -3.12 tests/equivalence/generate_python_compat_golden.py --check  # verify

The table records inputs and what Python 3.12 returns for them (or that it
raises). The TypeScript tests replay every row. Output is deterministic: no
clock, no randomness without a fixed seed, and no locale dependence.
"""

import json
import random
import sys
import unicodedata
from datetime import date, datetime, timedelta, timezone
from email.utils import parsedate_to_datetime
from pathlib import Path
from zoneinfo import ZoneInfo

REPO_ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO_ROOT))

from people_due import add_calendar_months  # noqa: E402

GOLDEN_PATH = Path(__file__).resolve().parent / "golden" / "python-compat.json"

# A fixed "now" for HTTP-date Retry-After rows: 2026-10-13T12:00:00Z.
HTTP_DATE_NOW = datetime(2026, 10, 13, 12, 0, 0, tzinfo=timezone.utc)

STRING_SAMPLES = [
    "",
    "a",
    "Hello World",
    "  padded  ",
    "æøå ÆØÅ",
    "Ærø Øresund Århus",
    "straße STRASSE ẞ",
    "İstanbul ıi",
    "ΟΔΟΣ οδος Σίσυφος",
    "ς σ Σ",
    "ﬁne ﬀ µ ſ",
    "Ꭰꭰ Ᏸᏸ",
    "é é",
    "Å Å",
    "😀",
    "a😀b",
    "👩‍👩‍👧",
    "𝔘𝔫𝔦𝔠𝔬𝔡𝔢",
    "\x1c\x1d\x1e\x1fx\x1c",
    " nbsp ",
    " line ",
    "﻿bom﻿",
    "​zero width​",
    "　ideographic　",
    "\x85next line\x85",
    "\t tab\tand\nnewline\r\n",
    "\x0b\x0cvt ff",
    "quote \" and backslash \\",
    "control \x00\x01\x07\x1b\x7f",
    "a  b\t\tc\n\nd",
    "  leading",
    "trailing  ",
    " ogham᠎mongolian",
    "           ",
    "  ",
    "\ud800 lone surrogate",
    "￿ vs \U0001f600",
]

ISSPACE_SAMPLES = [
    "",
    " ",
    "  ",
    "\t",
    "\n",
    "\x0b",
    "\x0c",
    "\r",
    "\x1c",
    "\x1d",
    "\x1e",
    "\x1f",
    "\x85",
    " ",
    " ",
    "᠎",
    "​",
    " ",
    " ",
    " ",
    " ",
    "　",
    "﻿",
    "a",
    " a",
    "😀",
]

TRUNCATE_CASES = [
    ("", 5, "…"),
    ("abcde", 5, "…"),
    ("abcdef", 5, "…"),
    ("abcdef", 1, "…"),
    ("abcdef", 0, "…"),
    ("abcdef", 3, "..."),
    ("abcdef", 2, "..."),
    ("😀😀😀😀😀", 5, "…"),
    ("😀😀😀😀😀😀", 5, "…"),
    ("abc😀def", 4, "…"),
    ("abc😀def", 5, "…"),
    ("abc😀def", 3, "…"),
    ("ééé", 4, "…"),
    ("ééé", 5, "…"),
    ("👩‍👩‍👧 family", 4, "…"),
    ("æøåæøå", 4, "…"),
    ("x" * 75, 75, "…"),
    ("x" * 76, 75, "…"),
    ("😀" * 76, 75, "…"),
    ("y" * 3001, 3000, "…"),
]

SLICE_CASES = [
    ("abcdef", 0, 3),
    ("abcdef", 2, None),
    ("abcdef", -2, None),
    ("abcdef", 0, -1),
    ("abcdef", 4, 2),
    ("a😀b😀c", 1, 4),
    ("a😀b😀c", -2, None),
    ("suggest Anna", 7, None),
]

COMPARE_CASES = [
    ("a", "b"),
    ("b", "a"),
    ("a", "a"),
    ("", "a"),
    ("a", ""),
    ("abc", "abd"),
    ("ab", "abc"),
    ("Z", "a"),
    ("æ", "z"),
    ("å", "æ"),
    ("ø", "å"),
    ("￿", "\U0001f600"),
    ("\U0001f600", "￿"),
    ("", "\U00010000"),
    ("a\U0001f600", "a￿"),
    ("ss", "ß"),
]

JSON_CASES = [
    None,
    True,
    False,
    0,
    -1,
    42,
    9007199254740991,
    -9007199254740991,
    0.5,
    -0.25,
    0.1,
    1e-7,
    123.456,
    1.5e-5,
    0.0001,
    "",
    "plain",
    "æøå ÆØÅ",
    "ß ẞ İ",
    "😀",
    "a😀b",
    "\ud800",
    "é",
    "quote \" backslash \\ slash /",
    "\n\r\t\b\f",
    "\x00\x01\x1b\x1c\x1f\x7f",
    "   ﻿",
    "<script>&'",
    [],
    {},
    [1, "two", None, True],
    {"a": 1, "b": [1, 2, {"c": "d"}]},
    {"z": 1, "a": 2, "m": 3},
    {"person": {"id": "abc-123", "name": "Ærø Ørsted"}, "type": "Møde"},
    {"name": "Følg op 😀", "priority": "High", "follow_up": "2026-10-20", "notes": "Line 1\nLine 2\t\"q\""},
    {"nested": {"deeper": {"deepest": ["x", {"k": "v"}]}}},
    {"ключ": "значение", "键": "值"},
    [[[]], [{}], ""],
]

FLOAT_CASES = [
    "2",
    " 1.5 ",
    "1_0",
    "inf",
    "nan",
    "-1",
    "",
    "abc",
    "1e2",
    "+3",
    ".5",
    "5.",
    "-.5",
    "1__0",
    "_1",
    "1_",
    "1_.5",
    "1._5",
    "1e1_0",
    "0x10",
    "Infinity",
    "-inf",
    "+INF",
    "iNfInItY",
    "-nan",
    "nan(1)",
    "infinit",
    "1e400",
    "-1e400",
    "1e-400",
    "1e",
    "e1",
    ".",
    "1.5e-3",
    "1.5E+3",
    "-0",
    "1,5",
    "1 2",
    "\t2\n",
    "\x0b3\x0c",
    "\x1c1\x1c",
    " 1 ",
    " 4　",
    "﻿5",
    "١٢",
    "٣.٥",
    "１０",
    "𝟏𝟐",
    "²",
    "0.1",
    "00012",
    "3.0",
    "120",
    "1.0000000000000002",
]

INT_CASES = [
    "0",
    "12",
    "-5",
    "+7",
    " 8 ",
    "1_000",
    "1__0",
    "_1",
    "1_",
    "",
    "1.0",
    "0x1",
    "007",
    "١٢",
    "-0",
    "\x1c1",
    " 2",
    "abc",
]

ISO_DATE_SAMPLES = [
    "2026-10-13",
    "20261013",
    "2026-W42-2",
    "2026W422",
    "2026-W42",
    "2026W42",
    "2026-W53",
    "2026-W53-1",
    "2020-W53-1",
    "2020-W53-7",
    "2015-W53-4",
    "2026-W00-1",
    "2026-W42-0",
    "2026-W42-8",
    "0001-W01-1",
    "9999-W52-5",
    "9999-W52-6",
    "2026-10-13T09:00:00",
    "2026-10-13T09:00:00.000+02:00",
    "2026-10-13T23:30:00Z",
    "2026-10-13 09:00",
    "2026-13-01",
    "2026-00-10",
    "2026-10-00",
    "2026-10-32",
    "2026-02-29",
    "2024-02-29",
    "2000-02-29",
    "1900-02-29",
    "2026-04-31",
    "0000-01-01",
    "0001-01-01",
    "9999-12-31",
    "",
    "2026",
    "2026-10",
    "202610",
    "2026-1-13",
    "2026-10-1",
    "20261013xy",
    "2026W422xy",
    "2026-10-13é",
    "20261013é",
    "2026-10é",
    " 2026-10-13",
    "2026-10-13 ",
    "2026/10/13",
    "2026-1013",
    "202610-13",
    "2026W42-2",
    "2026-W422",
    "2026-W42X2",
    "２０２６-10-13",
    "2026-10-13\x00",
    "2026-10-1\ud800",
    "-2026-10-13",
    "+2026-10-13",
    "2026-10-13T",
]

ISO_DATETIME_SAMPLES = ISO_DATE_SAMPLES + [
    "2026-10-13T09:00:00+24:00",
    "2026-10-13T09:00:00+23:59",
    "2026-10-13T09:00:00-23:59:59.999999",
    "2026-10-13T09:00:00+23:59:59.999999",
    "2026-10-13T09:00:00-24:00",
    "2026-10-13T09",
    "2026-10-13T0900",
    "2026-10-13T090000",
    "2026-10-13T09:00:00,5",
    "2026-10-13T09:00:00.1234567",
    "2026-10-13T09:00:00.1",
    "2026-10-13T09:00:00.",
    "2026-10-13T24:00:00",
    "2026-10-13T23:59:59",
    "2026-10-13T09:60",
    "2026-10-13T09:00:60",
    "2026-10-13T09:00:00+0200",
    "2026-10-13T09:00:00+02",
    "2026-10-13T09:00:00+2",
    "2026-10-13T09:00:00Z+01:00",
    "2026-10-13T09:00:00z",
    "2026-10-13T09:00:00 +02:00",
    "2026-10-13T09:00+02:00junk",
    "2026-10-13X09:00",
    "2026-10-13é09:00",
    "2026-10-13\ud80009:00",
    "2026-W42-2T09:00",
    "2026W422T09",
    "2026W42T09",
    "2026-W42T09:00",
    "2026-W42-09:00",
    "2026-10-13T09:00:00.000-00:00",
    "2026-10-12T23:30:00-05:00",
    "2026-10-13T00:30:00+14:00",
    "2026-10-13T09:00:00.000Z",
    "2026-10-13T09:00:00.000000Z",
    "2026-10-13T09:00:00+02:00:30",
    "2026-10-13T09:00:00+02:00:30.5",
    "2026-10-13T9:00",
    "2026-10-13T09:0",
    "2026-10-13T09:00:00:00",
    "2026-10-13T09:00:00Z ",
    "20261013T090000Z",
    "20261013T0900",
    "2026-10-13T",
    "2026-10-13TT",
    "2026-10-13T-01:00",
    "2026-10-13TZ",
]

DATE_TEMPLATES = [
    "2026-10-13",
    "20261013",
    "2026-W42-2",
    "2026W422",
    "2026-10-13T09:00:00.000+02:00",
    "2026-10-13T09:00Z",
    "20261013T0900-0130",
    "2026-W42-2T09:00:00",
]
MUTATION_ALPHABET = "0123456789-WT:+Z., é"


def fuzzed_date_strings(count):
    """Deterministic variations of valid templates (fixed seed)."""
    rng = random.Random(20261013)
    samples = []
    for _ in range(count):
        chars = list(rng.choice(DATE_TEMPLATES))
        for _ in range(rng.randint(1, 3)):
            operation = rng.random()
            position = rng.randrange(len(chars) + 1)
            if operation < 0.4 and chars:
                chars[min(position, len(chars) - 1)] = rng.choice(MUTATION_ALPHABET)
            elif operation < 0.7 and chars:
                del chars[min(position, len(chars) - 1)]
            else:
                chars.insert(position, rng.choice(MUTATION_ALPHABET))
        samples.append("".join(chars))
    return samples


ADD_CALENDAR_MONTHS_CASES = [
    ("2026-01-31", 1),
    ("2026-01-31", 2),
    ("2024-01-31", 1),
    ("2024-02-29", 12),
    ("2024-02-29", 48),
    ("2000-01-31", 1),
    ("1900-01-31", 1),
    ("2026-03-31", -1),
    ("2026-01-15", -1),
    ("2026-01-15", -13),
    ("2026-12-31", 2),
    ("2026-10-13", 0),
    ("2026-10-13", 3),
    ("2026-10-13", 6),
    ("2026-10-13", 12),
    ("2026-10-13", 24),
    ("2026-10-13", -25),
    ("2026-10-13", 120),
    ("2026-05-31", 1),
    ("2026-08-31", 1),
    ("0001-01-01", -1),
    ("0001-12-31", -12),
    ("9999-12-01", 1),
    ("9999-01-31", 11),
]

ADD_DAYS_CASES = [
    ("2026-10-13", 0),
    ("2026-10-13", 7),
    ("2026-10-13", -13),
    ("2026-12-31", 1),
    ("2024-02-28", 1),
    ("2026-02-28", 1),
    ("2026-10-13", 365),
    ("2026-10-13", -36500),
    ("0001-01-01", -1),
    ("9999-12-31", 1),
    ("0001-01-01", 3652058),
]

HTTP_DATE_CASES = [
    "Tue, 13 Oct 2026 12:00:05 GMT",
    "Tue, 13 Oct 2026 12:00:05 UTC",
    "Tue, 13 Oct 2026 12:00:05 Z",
    "Tue, 13 Oct 2026 12:00:05 +0000",
    "Tue, 13 Oct 2026 14:00:05 +0200",
    "Tue, 13 Oct 2026 07:00:05 EST",
    "Tue, 13 Oct 2026 12:00:05 -0000",
    "Tue, 13 Oct 2026 12:00:05",
    "13 Oct 2026 12:00:05 GMT",
    "Tue,13 Oct 2026 12:00:05 GMT",
    "Tuesday, 13-Oct-26 12:00:05 GMT",
    "Tue Oct 13 12:00:05 2026",
    "Wed, 21 Oct 2015 07:28:00 GMT",
    "Tue, 13 Oct 26 12:00:05 GMT",
    "Tue, 13 Oct 99 12:00:05 GMT",
    "Tue, 13 Oct 0 12:00:05 GMT",
    "Tue, 13 october 2026 12:00:05 GMT",
    "Tue, 13 OCT 2026 12:00:05 gmt",
    "Tue, Oct 13 2026 12:00:05 GMT",
    "Tue, 13 Oct 2026, 12:00:05 GMT",
    "Tue, 13 Oct 2026 12:00 GMT",
    "Tue, 13 Oct 2026 12.00.05 GMT",
    "Tue, 13 Oct 2026 12.00 GMT",
    "Tue, 13 Oct 2026 12:00:05+0100",
    "Tue, 13 Oct 2026 12:00:05 +2500",
    "Tue, 13 Oct 2026 12:00:05 +2359",
    "Tue, 13 Oct 2026 12:00:05 bogus",
    "Tue, 32 Oct 2026 12:00:05 GMT",
    "Tue, 29 Feb 2026 12:00:05 GMT",
    "Tue, 29 Feb 2028 12:00:05 GMT",
    "Tue, 13 Oct 2026 25:00:05 GMT",
    "Tue, 13 Oct 2026 12:60:05 GMT",
    "Tue, 13 Oct 2026 12:00:60 GMT",
    "Tue, 13 Oct 2026 -1:00:05 GMT",
    "Tue, 13 Foo 2026 12:00:05 GMT",
    "Tue, 13 Oct 10000 12:00:05 GMT",
    "Tue, 13 Oct 2026 12:00:05:01 GMT",
    "Tue, 13 Oct 2026 12 GMT",
    "\x1cTue,\x1c13 Oct 2026 12:00:05 GMT",
    "Tue, 13 Oct 2026 12:00:05 GMT",
    "Tue, ١٣ Oct 2026 12:00:05 GMT",
    "2",
    " 1.5 ",
    "1_0",
    "inf",
    "nan",
    "-1",
    "",
    "   ",
    "abc",
    "1e2",
    "Tue,",
    "13 Oct",
]

COPENHAGEN_INSTANTS = [
    "2026-10-12T21:59:59+00:00",
    "2026-10-12T22:00:00+00:00",
    "2026-10-13T12:00:00+00:00",
    "2026-10-24T22:00:00+00:00",
    "2026-10-25T00:59:59+00:00",
    "2026-10-25T01:00:00+00:00",
    "2026-10-25T22:59:59+00:00",
    "2026-10-25T23:00:00+00:00",
    "2026-03-28T22:59:59+00:00",
    "2026-03-28T23:00:00+00:00",
    "2026-03-29T00:59:59+00:00",
    "2026-03-29T01:00:00+00:00",
    "2026-03-29T21:59:59+00:00",
    "2026-03-29T22:00:00+00:00",
    "2026-12-31T22:59:59+00:00",
    "2026-12-31T23:00:00+00:00",
    "2024-02-28T23:00:00+00:00",
    "1970-01-01T00:00:00+00:00",
]


def raises(function, *args):
    try:
        return False, function(*args)
    except Exception as error:  # noqa: BLE001 - the error type is recorded
        return True, type(error).__name__


def row_or_raises(row, function, *args, convert=lambda value: value):
    failed, value = raises(function, *args)
    if failed:
        row["raises"] = value
    else:
        row["output"] = convert(value)
    return row


def truncate(text, limit, suffix):
    if len(text) <= limit:
        return text
    return text[: limit - len(suffix)] + suffix


def py_compare(a, b):
    return (a > b) - (a < b)


def http_date_seconds(value):
    retry_at = parsedate_to_datetime(value)
    if retry_at.tzinfo is None:
        retry_at = retry_at.replace(tzinfo=timezone.utc)
    return (retry_at - HTTP_DATE_NOW).total_seconds()


def datetime_date(value):
    return datetime.fromisoformat(value.replace("Z", "+00:00")).date()


def unassigned_ranges():
    ranges = []
    start = None
    for code_point in range(0x110000):
        unassigned = unicodedata.category(chr(code_point)) == "Cn"
        if unassigned and start is None:
            start = code_point
        elif not unassigned and start is not None:
            ranges.append([start, code_point - 1])
            start = None
    if start is not None:
        ranges.append([start, 0x10FFFF])
    return ranges


def build_table():
    date_inputs = list(dict.fromkeys(ISO_DATE_SAMPLES + fuzzed_date_strings(300)))
    datetime_inputs = list(dict.fromkeys(ISO_DATETIME_SAMPLES + fuzzed_date_strings(300)))
    return {
        "meta": {
            "python": f"{sys.version_info.major}.{sys.version_info.minor}",
            "unicode": unicodedata.unidata_version,
            "http_date_now": HTTP_DATE_NOW.isoformat(),
        },
        "casefold": [{"input": s, "output": s.casefold()} for s in STRING_SAMPLES],
        "casefold_all": {
            "changed": [
                [cp, chr(cp).casefold()]
                for cp in range(0x110000)
                if chr(cp).casefold() != chr(cp)
            ],
            "unassigned_ranges": unassigned_ranges(),
        },
        "isspace": [{"input": s, "output": s.isspace()} for s in ISSPACE_SAMPLES],
        "isspace_all": [cp for cp in range(0x110000) if chr(cp).isspace()],
        "strip": [{"input": s, "output": s.strip()} for s in STRING_SAMPLES],
        "split": [{"input": s, "output": s.split()} for s in STRING_SAMPLES],
        "len": [{"input": s, "output": len(s)} for s in STRING_SAMPLES],
        "starts_with_space": [
            {"input": s, "output": s[0].isspace()} for s in STRING_SAMPLES if s
        ],
        "truncate": [
            {"input": text, "limit": limit, "suffix": suffix, "output": truncate(text, limit, suffix)}
            for text, limit, suffix in TRUNCATE_CASES
        ],
        "slice": [
            {"input": text, "start": start, "stop": stop, "output": text[start:stop]}
            for text, start, stop in SLICE_CASES
        ],
        "compare": [{"a": a, "b": b, "output": py_compare(a, b)} for a, b in COMPARE_CASES],
        "json_dumps": [{"input": value, "output": json.dumps(value)} for value in JSON_CASES],
        "float": [row_or_raises({"input": s}, float, s, convert=repr) for s in FLOAT_CASES],
        "int": [row_or_raises({"input": s}, int, s) for s in INT_CASES],
        "date_fromisoformat": [
            row_or_raises({"input": s}, date.fromisoformat, s, convert=date.isoformat)
            for s in date_inputs
        ],
        "datetime_fromisoformat_date": [
            row_or_raises({"input": s}, datetime_date, s, convert=date.isoformat)
            for s in datetime_inputs
        ],
        "add_calendar_months": [
            row_or_raises(
                {"date": value, "months": months},
                add_calendar_months,
                date.fromisoformat(value),
                months,
                convert=date.isoformat,
            )
            for value, months in ADD_CALENDAR_MONTHS_CASES
        ],
        "add_days": [
            row_or_raises(
                {"date": value, "days": days},
                lambda d, n: d + timedelta(days=n),
                date.fromisoformat(value),
                days,
                convert=date.isoformat,
            )
            for value, days in ADD_DAYS_CASES
        ],
        "http_date": [
            row_or_raises({"input": s}, http_date_seconds, s) for s in HTTP_DATE_CASES
        ],
        "copenhagen_today": [
            {
                "epoch_ms": int(datetime.fromisoformat(instant).timestamp() * 1000),
                "output": datetime.fromisoformat(instant)
                .astimezone(ZoneInfo("Europe/Copenhagen"))
                .date()
                .isoformat(),
            }
            for instant in COPENHAGEN_INSTANTS
        ],
    }


def render(table):
    """One row per line, ASCII-only, so diffs stay readable."""
    lines = ["{"]
    sections = list(table.items())
    for index, (name, value) in enumerate(sections):
        comma = "," if index < len(sections) - 1 else ""
        if isinstance(value, list):
            lines.append(f" {json.dumps(name)}: [")
            for row_index, row in enumerate(value):
                row_comma = "," if row_index < len(value) - 1 else ""
                lines.append(f"  {json.dumps(row)}{row_comma}")
            lines.append(f" ]{comma}")
        elif name == "casefold_all":
            lines.append(f" {json.dumps(name)}: {{")
            parts = list(value.items())
            for part_index, (key, rows) in enumerate(parts):
                part_comma = "," if part_index < len(parts) - 1 else ""
                lines.append(f"  {json.dumps(key)}: [")
                for row_index, row in enumerate(rows):
                    row_comma = "," if row_index < len(rows) - 1 else ""
                    lines.append(f"   {json.dumps(row)}{row_comma}")
                lines.append(f"  ]{part_comma}")
            lines.append(f" }}{comma}")
        else:
            lines.append(f" {json.dumps(name)}: {json.dumps(value)}{comma}")
    lines.append("}")
    return "\n".join(lines) + "\n"


def main(argv):
    if sys.version_info[:2] != (3, 12):
        print("This generator must run on Python 3.12, the CI reference version.")
        return 2
    content = render(build_table())
    if "--check" in argv:
        try:
            committed = GOLDEN_PATH.read_text(encoding="utf-8")
        except FileNotFoundError:
            print(f"Missing golden table: {GOLDEN_PATH.relative_to(REPO_ROOT)}")
            return 1
        if committed != content:
            print("Golden table is out of date. Regenerate it with Python 3.12.")
            return 1
        print("Golden table is up to date.")
        return 0
    GOLDEN_PATH.parent.mkdir(parents=True, exist_ok=True)
    with GOLDEN_PATH.open("w", encoding="utf-8", newline="\n") as handle:
        handle.write(content)
    print(f"Wrote {GOLDEN_PATH.relative_to(REPO_ROOT)}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
