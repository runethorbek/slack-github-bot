"""Generate the followup_task fixture for src/followup-task.ts.

Run with the CI reference Python (3.12):

    py -3.12 tests/equivalence/generate_followup_task_fixture.py          # write
    py -3.12 tests/equivalence/generate_followup_task_fixture.py --check  # verify

The fixture records, from the unmodified Python module, every constant and
user-facing message (including the Gemini system instruction), fully built
follow-up suggestion prompts, complete Block Kit buttons (the value strings
byte for byte), and what parse_suggested_task, parse_suggested_follow_up,
parse_task_payload and the confirmation template return for edge-case input.
tests/followup-task.test.ts compares the TypeScript output with it. Output is
deterministic.
"""

import json
import sys
from datetime import date
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO_ROOT))

import followup_task  # noqa: E402
from followup_task import (  # noqa: E402
    FOLLOWUP_TASK_ADDED_MESSAGE_TEMPLATE,
    ISO_DATE_PATTERN,
    SuggestedTask,
    build_followup_suggestion_prompt,
    followup_task_button,
    parse_suggested_follow_up,
    parse_suggested_task,
    parse_task_payload,
)

FIXTURE_PATH = Path(__file__).resolve().parent / "followup-task-fixture.json"

TODAY = "2026-09-26"

CONSTANT_NAMES = [
    "ADD_FOLLOWUP_TASK_ACTION_ID",
    "ADD_SUGGESTED_FOLLOWUP_TASK_ACTION_ID",
    "ADD_FOLLOWUP_TASK_CALLBACK_ID",
    "TASK_PEOPLE_PROPERTY",
    "TASK_TRACK_PROPERTY",
    "TASK_PRIORITY_PROPERTY",
    "TASK_STATUS_PROPERTY",
    "TASK_FOLLOW_UP_PROPERTY",
    "TASK_CREATED_PROPERTY",
    "TASK_DESCRIPTION_PROPERTY",
    "TASK_STATUS_NOT_STARTED",
    "SLACK_BUTTON_VALUE_LIMIT",
    "SLACK_BUTTON_TEXT_LIMIT",
    "MAX_SUGGESTED_TASK_NAME_CHARS",
    "MAX_SUGGESTED_TASK_DESCRIPTION_CHARS",
    "MAX_SUGGESTED_FOLLOW_UP_DAYS",
    "FOLLOWUP_SUGGESTION_SYSTEM_INSTRUCTION",
    "FOLLOWUP_TASK_ADDED_MESSAGE_TEMPLATE",
    "FOLLOWUP_TASK_INVALID_MESSAGE",
    "FOLLOWUP_TASK_FAILURE_MESSAGE",
    "FOLLOWUP_TASK_UNCERTAIN_MESSAGE",
    "FOLLOWUP_TASK_STATUS_MISSING_MESSAGE",
]

PROMPT_CASES = [
    {
        "person_name": "Jane Doe",
        "interaction_type": "Coffee",
        "notes": "  Agreed to send the AI article by Friday.  ",
        "interaction_date": "2026-09-25",
        "today": TODAY,
    },
    {
        "person_name": "Søren Æbelø \U0001f600",
        "interaction_type": "Gåtur",
        "notes": "　Linje et\nLinje to\t\"citat\" $& $1 {name}\x1c",
        "interaction_date": "2026-01-31",
        "today": "2026-02-01",
    },
    {
        "person_name": 'Jane "JD" Doe',
        "interaction_type": "Video call",
        "notes": "﻿BOM stays ",
        "interaction_date": "2025-12-31",
        "today": "2026-01-01",
    },
]

DANISH_TRACKS = [
    {"id": "t1", "name": "Ærø Netværk"},
    {"id": "t2", "name": "Østjylland"},
]

BUTTON_CASES = [
    {"person_page_id": "person-page-id", "person_name": "Jane Doe"},
    {
        "person_page_id": "p-1",
        "person_name": "Søren Æbelø",
        "tracks": DANISH_TRACKS,
        "default_track_id": "t2",
        "priorities": ["Høj", "Medium", "Lav"],
    },
    {
        "person_page_id": "p-1",
        "person_name": "Jane",
        "tracks": DANISH_TRACKS,
        "default_track_id": "",
        "priorities": [],
    },
    {
        "person_page_id": "p-1",
        "person_name": "Jane",
        "tracks": [],
        "default_track_id": "t1",
        "priorities": ["High"],
    },
    {
        "person_page_id": "p-1",
        "person_name": "Åse Ølund",
        "tracks": DANISH_TRACKS,
        "default_track_id": "t1",
        "priorities": ["High", "Low"],
        "suggested_task": {
            "name": "Send \"AI\" artiklen til Åse \\ Ølund",
            "description": "Linje et\nLinje to\t\"citat\"\r\n\U0001f600  ",
            "follow_up": "2026-10-02",
        },
    },
    {
        "person_page_id": "p-1",
        "person_name": "Jane Doe",
        "suggested_task": {"name": "Call back", "description": None, "follow_up": None},
    },
    {
        "person_page_id": "p-1",
        "person_name": "Jane Doe",
        "suggested_task": {"name": "x" * 64 + "\U0001f600" * 2, "description": "", "follow_up": None},
    },
    {
        "person_page_id": "p-1",
        "person_name": "Jane Doe",
        "suggested_task": {"name": "\U0001f600" * 66, "description": None, "follow_up": "2027-09-26"},
    },
    {
        "person_page_id": "p-1",
        "person_name": "Jane Doe",
        "suggested_task": {"name": "Send " + "a" * 140, "description": None, "follow_up": None},
    },
]


def suggestion(**task):
    return json.dumps({"task": task})


def fence(body, lang="json", before="\n", after="\n"):
    return f"```{lang}{before}{body}{after}```"


NAME_ONLY = suggestion(name="Send the article")

PARSE_SUGGESTED_TASK_CASES = [
    suggestion(name="  Send the article ", description=" About agents. ", follow_up="2026-10-01"),
    NAME_ONLY,
    '{"task": null}',
    "",
    "   ",
    "Send the article",
    "[]",
    "{}",
    '{"task": "Send"}',
    '{"task": ["Send"]}',
    # Fences
    fence(NAME_ONLY),
    fence(NAME_ONLY, lang=""),
    fence(NAME_ONLY, lang="JSON"),
    fence(NAME_ONLY, lang="js"),
    fence(NAME_ONLY, before="", after=""),
    fence(NAME_ONLY, before="　 ", after="\x1c\x85"),
    fence(NAME_ONLY, before="﻿", after="\n"),
    fence(NAME_ONLY, before="\n", after="﻿"),
    "  " + fence(NAME_ONLY) + "\n　",
    fence(NAME_ONLY) + "\nmore",
    fence(NAME_ONLY) + fence(NAME_ONLY),
    "```json\n" + NAME_ONLY,
    NAME_ONLY + "\n```",
    "```json" + NAME_ONLY + "```",
    "```jsonjson\n" + NAME_ONLY + "\n```",
    "````json\n" + NAME_ONLY + "\n````",
    "```json\n```",
    "``````",
    "```json\n" + suggestion(name="has ``` inside") + "\n```",
    "```\n" + suggestion(name="a\nb") + "\n```",
    # JSON edge cases: Python's json.loads, not JSON.parse
    '{"task": {"name": "x", "description": NaN}}',
    '{"task": {"name": "x", "description": "d", "follow_up": Infinity}}',
    '{"task": {"name": NaN}}',
    '{"task": {"name": "x"}, "extra": -Infinity}',
    '{"task": {"name": "x", "n": 1e400}}',
    '{"task": {"name": "x", "n": ' + "1" * 4301 + "}}",
    '{"task": {"name": "x", "n": ' + "1" * 4300 + "}}",
    "﻿" + NAME_ONLY,
    NAME_ONLY + " trailing",
    NAME_ONLY + "\x0b",
    "\x0c" + NAME_ONLY,
    NAME_ONLY + " 　\x1c",
    '{"task": {"name": "first"}, "task": {"name": "second"}}',
    '{"task": {"name": "x"}, "task": null}',
    '{"task": {"name": "x", "name": "y"}}',
    '{"task": {"name": "a\tb"}}',
    '{"task": {"name": "a\x7fb"}}',
    '{"task": {"name": "\\ud800"}}',
    '{"task": {"name": "\\ud83d\\ude00"}}',
    '{"task": {"name": "\\u00e9"}}',
    '{"__proto__": {"name": "x"}, "task": {"name": "y"}}',
    '{"task": {"name": "x", "follow_up": "2026-10-01", "description": null}}',
    '{"task": {"name": "x", "d": ' + "[" * 500 + "]" * 500 + "}}",
    '{"task": {"name": "x", "d": ' + "[" * 20000 + "]" * 20000 + "}}",
    # Names: code points, not UTF-16 units
    suggestion(name="x" * 150),
    suggestion(name="x" * 151),
    suggestion(name="\U0001f600" * 150),
    suggestion(name="\U0001f600" * 151),
    suggestion(name=" " * 10 + "x" * 150 + "　"),
    suggestion(name="　\x1c\x85"),
    suggestion(name="﻿"),
    suggestion(name=42),
    suggestion(name=True),
    suggestion(name=["x"]),
    suggestion(),
    # Descriptions
    suggestion(name="Send", description="d" * 500),
    suggestion(name="Send", description="d" * 501),
    suggestion(name="Send", description="\U0001f600" * 500),
    suggestion(name="Send", description="\U0001f600" * 501),
    suggestion(name="Send", description="  " + "d" * 500 + "\n"),
    suggestion(name="Send", description=42),
    suggestion(name="Send", description=["text"]),
    suggestion(name="Send", description="   "),
    suggestion(name="Send", description=False),
    # Follow-ups
    suggestion(name="Send", follow_up="2026-09-26"),
    suggestion(name="Send", follow_up="2027-09-26"),
    suggestion(name="Send", follow_up="2027-09-27"),
    suggestion(name="Send", follow_up="2026-09-25"),
    suggestion(name="Send", follow_up="2026-02-30"),
    suggestion(name="Send", follow_up="20261001"),
    suggestion(name="Send", follow_up="2026-W40-1"),
    suggestion(name="Send", follow_up="2026-10-01\n"),
    suggestion(name="Send", follow_up="2026-10-01T09:00"),
    suggestion(name="Send", follow_up="２０２６-１０-０１"),
    suggestion(name="Send", follow_up=20261001),
    suggestion(name="Send", priority="High", track_id="t1", status="Done"),
]

FOLLOW_UP_DIGITS = {
    "fullwidth": 0xFF10,
    "arabic_indic": 0x0660,
    "extended_arabic_indic": 0x06F0,
    "devanagari": 0x0966,
    "mathematical_bold": 0x1D7CE,
}


def with_digits(text, zero):
    return "".join(chr(zero + int(ch)) if ch.isdigit() else ch for ch in text)


SUGGESTED_FOLLOW_UP_CASES = (
    [
        ("2026-10-01", TODAY),
        ("2026-09-26", TODAY),
        ("2027-09-26", TODAY),
        ("2027-09-27", TODAY),
        ("2026-09-25", TODAY),
        ("2028-02-29", "2027-03-01"),
        ("2028-03-01", "2027-03-01"),
        ("2026-10-01\n", TODAY),
        ("2026-10-01\n\n", TODAY),
        ("2026-10-01\r", TODAY),
        ("2026-10-01\r\n", TODAY),
        ("2026-10-01 ", TODAY),
        (" 2026-10-01", TODAY),
        ("2026-10-01 ", TODAY),
        ("2026-10-01\x85", TODAY),
        ("2026-10-01\nx", TODAY),
        ("²026-10-01", TODAY),
        ("2026-1０-01", TODAY),
        ("2026-10-1", TODAY),
        ("202-10-01", TODAY),
        ("20261001", TODAY),
        ("2026-W40-4", TODAY),
        ("2026-13-01", TODAY),
        ("9999-12-31", "9999-12-31"),
        ("9999-12-30", "9999-12-31"),
        ("2026-10-01", "9999-12-31"),
        ("", TODAY),
        (None, TODAY),
        (20261001, TODAY),
        (["2026-10-01"], TODAY),
    ]
    + [(with_digits("2026-10-01", zero), TODAY) for zero in FOLLOW_UP_DIGITS.values()]
    + [(with_digits("2026-10-01", zero) + "\n", TODAY) for zero in FOLLOW_UP_DIGITS.values()]
)

ADDED_MESSAGE_CASES = [
    ("Jane Doe", "Send the article"),
    ("Jane {task}", "T {name}"),
    ("$& $1 $$", "$` $'"),
    ("Søren \U0001f600", "Æbler"),
    ("{name}", "{task}"),
]

PARSE_TASK_PAYLOAD_CASES = [
    json.dumps(
        {
            "name": "Send the article",
            "description": "Line one\nLine two",
            "follow_up": "2026-10-01",
            "priority": "High",
            "track_id": "t1",
        }
    ),
    "",
    "not json",
    "[1]",
    '"name"',
    "null",
    json.dumps({"name": 5, "description": 7, "priority": ["High"]}),
    '{"name": NaN, "description": Infinity, "follow_up": "2026-10-01"}',
    '{"name": "a", "name": "b", "priority": null}',
    "﻿" + json.dumps({"name": "x"}),
    " \t" + json.dumps({"name": "x"}) + "\n",
    " " + json.dumps({"name": "x"}),
    json.dumps({"name": "Æbler \U0001f600", "track_id": "tø"}),
    '{"name": "x", "deep": ' + "[" * 20000 + "]" * 20000 + "}",
]


def date_or_none(value):
    return None if value is None else date.fromisoformat(value)


def suggested_task_from(spec):
    if spec is None:
        return None
    return SuggestedTask(spec["name"], spec["description"], date_or_none(spec["follow_up"]))


def suggested_task_output(task):
    if task is None:
        return None
    return {
        "name": task.name,
        "description": task.description,
        "follow_up": None if task.follow_up is None else task.follow_up.isoformat(),
    }


def raises_or(row, function, *args, convert=lambda value: value):
    try:
        value = function(*args)
    except Exception as error:  # noqa: BLE001 - the error type is recorded
        row["raises"] = type(error).__name__
        return row
    row["output"] = convert(value)
    return row


def build_fixture():
    today = date.fromisoformat(TODAY)
    return {
        "meta": {"python": f"{sys.version_info.major}.{sys.version_info.minor}"},
        "constants": {name: getattr(followup_task, name) for name in CONSTANT_NAMES}
        | {"ISO_DATE_PATTERN": ISO_DATE_PATTERN.pattern},
        "prompts": [
            case
            | {
                "output": build_followup_suggestion_prompt(
                    case["person_name"],
                    case["interaction_type"],
                    case["notes"],
                    date.fromisoformat(case["interaction_date"]),
                    date.fromisoformat(case["today"]),
                )
            }
            for case in PROMPT_CASES
        ],
        "buttons": [
            case
            | {
                "output": followup_task_button(
                    case["person_page_id"],
                    case["person_name"],
                    case.get("tracks", ()),
                    case.get("default_track_id"),
                    case.get("priorities", ()),
                    suggested_task_from(case.get("suggested_task")),
                )
            }
            for case in BUTTON_CASES
        ],
        "parse_suggested_task": [
            raises_or(
                {"input": response, "today": TODAY},
                parse_suggested_task,
                response,
                today,
                convert=suggested_task_output,
            )
            for response in PARSE_SUGGESTED_TASK_CASES
        ],
        "suggested_follow_up": [
            raises_or(
                {
                    "input": value,
                    "today": case_today,
                    "pattern_match": isinstance(value, str)
                    and bool(ISO_DATE_PATTERN.match(value)),
                },
                parse_suggested_follow_up,
                value,
                date.fromisoformat(case_today),
                convert=lambda result: None if result is None else result.isoformat(),
            )
            for value, case_today in SUGGESTED_FOLLOW_UP_CASES
        ],
        "added_message": [
            {
                "name": name,
                "task": task,
                "output": FOLLOWUP_TASK_ADDED_MESSAGE_TEMPLATE.format(name=name, task=task),
            }
            for name, task in ADDED_MESSAGE_CASES
        ],
        "parse_task_payload": [
            raises_or({"input": value}, parse_task_payload, value)
            for value in PARSE_TASK_PAYLOAD_CASES
        ],
    }


def render(fixture):
    """One row per line, ASCII-only, so diffs stay readable."""
    lines = ["{"]
    sections = list(fixture.items())
    for index, (name, value) in enumerate(sections):
        comma = "," if index < len(sections) - 1 else ""
        if isinstance(value, list):
            lines.append(f" {json.dumps(name)}: [")
            for row_index, row in enumerate(value):
                row_comma = "," if row_index < len(value) - 1 else ""
                lines.append(f"  {json.dumps(row)}{row_comma}")
            lines.append(f" ]{comma}")
        else:
            lines.append(f" {json.dumps(name)}: {json.dumps(value, indent=1)}{comma}")
    lines.append("}")
    return "\n".join(lines) + "\n"


def main(argv):
    if sys.version_info[:2] != (3, 12):
        print("This generator must run on Python 3.12, the CI reference version.")
        return 2
    content = render(build_fixture())
    if "--check" in argv:
        try:
            committed = FIXTURE_PATH.read_text(encoding="utf-8")
        except FileNotFoundError:
            print(f"Missing fixture: {FIXTURE_PATH.relative_to(REPO_ROOT)}")
            return 1
        if committed != content:
            print("followup_task fixture is out of date. Regenerate it with Python 3.12.")
            return 1
        print("followup_task fixture is up to date.")
        return 0
    with FIXTURE_PATH.open("w", encoding="utf-8", newline="\n") as handle:
        handle.write(content)
    print(f"Wrote {FIXTURE_PATH.relative_to(REPO_ROOT)}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
