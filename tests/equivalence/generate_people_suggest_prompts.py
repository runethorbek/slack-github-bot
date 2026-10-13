"""Generate the people_suggest prompt and text fixture for src/people-suggest.ts.

Run with the CI reference Python (3.12):

    py -3.12 tests/equivalence/generate_people_suggest_prompts.py          # write
    py -3.12 tests/equivalence/generate_people_suggest_prompts.py --check  # verify

The fixture records, from the unmodified Python module, every Gemini prompt
constant and user-facing message, fully built recap and draft prompts for a
set of inputs, next-step splitting results, and reply text and Block Kit
blocks. tests/people-suggest.test.ts compares the TypeScript output with it
byte for byte. Output is deterministic.
"""

import json
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO_ROOT))

import people_suggest  # noqa: E402
from people_suggest import (  # noqa: E402
    InteractionSummary,
    PersonProfile,
    TrackContext,
    build_recap_prompt,
    build_suggestion_blocks,
    build_suggestion_prompt,
    format_full_reply,
    format_next_steps,
    format_suggestion_message,
    split_recap_and_next_steps,
)

FIXTURE_PATH = Path(__file__).resolve().parent / "people-suggest-prompts.json"

CONSTANT_NAMES = [
    "SUGGESTION_SYSTEM_INSTRUCTION",
    "RECAP_RULES",
    "RECAP_TRACK_FOCUS_RULES",
    "SUGGESTION_TRACK_RULES",
    "RECAP_SYSTEM_INSTRUCTION",
    "RECAP_WITH_NEXT_STEP_SYSTEM_INSTRUCTION",
    "PEOPLE_SUGGEST_FAILURE_MESSAGE",
    "GEMINI_TRANSIENT_FAILURE_MESSAGE",
    "INTERACTION_TYPE_UNAVAILABLE_NOTE",
    "NEXT_STEP_MARKER",
    "WAIT_NEXT_STEP_KIND",
    "PERSON_TRACK_PROPERTY",
    "TRACK_PURPOSE_PROPERTY",
    "MAX_SUGGESTION_INTERACTIONS",
    "MAX_SUGGESTION_TRACKS",
    "MAX_TRACK_PURPOSE_CHARS",
    "MAX_NEXT_STEP_SUGGESTIONS",
    "SLACK_SECTION_TEXT_LIMIT",
    "PERSON_CONTEXT_PROPERTIES",
]

MESSAGE_NAMES = ["Jane Doe", 'Jane "JD" Doe', "\u00c6r\u00f8 \u00d8sterg\u00e5rd \U0001f600"]

UNICODE_NOTES = "Talked about \u00e6bler og \u00f8l\nSecond line\tand a tab \U0001f600"

PROMPT_CASES = [
    {
        "name": "bare person",
        "profile": {"page_id": "p1", "name": "Jane Doe", "context_fields": [], "track_ids": []},
        "interactions": [],
        "person_tracks": [],
        "other_tracks": [],
        "next_step_kinds": [],
    },
    {
        "name": "context fields and interactions, next step requested",
        "profile": {
            "page_id": "p1",
            "name": "Jane Doe",
            "context_fields": [
                ["Why this person", "Former colleague"],
                ["Relationship intent", "Mentor"],
                ["Interests", "Climbing, Chess"],
                ["Notes", "Met at the conference"],
            ],
            "track_ids": [],
        },
        "interactions": [
            {"date": "2026-08-01", "type": "Call", "title": "Catch-up", "notes": "Talked shop", "track_ids": []},
            {"date": "2026-07-01", "type": None, "title": None, "notes": "Only notes", "track_ids": []},
            {"date": None, "type": "Coffee", "title": "No date", "notes": None, "track_ids": []},
        ],
        "person_tracks": [],
        "other_tracks": [],
        "next_step_kinds": ["Coffee", "Wait"],
    },
    {
        "name": "both Track groups with and without Purposes",
        "profile": {"page_id": "p1", "name": "Jane Doe", "context_fields": [], "track_ids": ["t1"]},
        "interactions": [
            {"date": "2026-08-01", "type": "Coffee", "title": "Coffee", "notes": None, "track_ids": ["t2"]},
        ],
        "person_tracks": [
            {"name": "AI Network", "purpose": "Learn about AI"},
            {"name": "Board", "purpose": None},
        ],
        "other_tracks": [
            {"name": "Investors", "purpose": "Raise a seed round"},
            {"name": "Hiring", "purpose": None},
        ],
        "next_step_kinds": ["Coffee", "Call: video", "Wait"],
    },
    {
        "name": "only other Tracks, no next step",
        "profile": {"page_id": "p1", "name": "Jane Doe", "context_fields": [], "track_ids": []},
        "interactions": [],
        "person_tracks": [],
        "other_tracks": [{"name": "Investors", "purpose": None}],
        "next_step_kinds": [],
    },
    {
        "name": "only Person Tracks, next step requested",
        "profile": {"page_id": "p1", "name": "Jane Doe", "context_fields": [], "track_ids": ["t1"]},
        "interactions": [],
        "person_tracks": [{"name": "AI Network", "purpose": "Learn about AI"}],
        "other_tracks": [],
        "next_step_kinds": ["Wait", "Coffee"],
    },
    {
        "name": "Unicode everywhere",
        "profile": {
            "page_id": "p-\u00e6",
            "name": "\u00c6r\u00f8 \u00d8sterg\u00e5rd \U0001f600",
            "context_fields": [["Why this person", "Stra\u00dfe \u2014 \u201cquoted\u201d"], ["Expertise", "\u65e5\u672c\u8a9e"]],
            "track_ids": ["t1"],
        },
        "interactions": [
            {
                "date": "2026-08-01",
                "type": "M\u00f8de",
                "title": "Fika \u2615",
                "notes": UNICODE_NOTES,
                "track_ids": ["t1"],
            },
        ],
        "person_tracks": [{"name": "\u00c5rhus netv\u00e6rk", "purpose": "L\u00e6r om AI " + "x" * 485 + "\u2026"}],
        "other_tracks": [],
        "next_step_kinds": ["M\u00f8de", "\U0001f600 Chat", "Wait"],
    },
]

SPLIT_CASES = [
    {"response": "- R.\nNEXT STEP:\n- Coffee: A.\n- Wait: B.", "allowed_kinds": ["Coffee", "Wait"]},
    {"response": "- R.\r\nNEXT STEP:\r\n- Coffee: A.\r\n- Wait: B.\r\n", "allowed_kinds": ["Coffee", "Wait"]},
    {"response": "- R.\u2028NEXT STEP:\u2029- Coffee: A.", "allowed_kinds": ["Coffee", "Wait"]},
    {
        "response": "- R.\x85**Next step:**\x85\u2022 Coffee: A.\x0c* Wait: B.\x1c- Coffee: C.",
        "allowed_kinds": ["Coffee", "Wait"],
    },
    {
        "response": "  - R.  \n\nnext steps: Coffee:   idea  \n- Call: video: X\n",
        "allowed_kinds": ["Call", "Call: video", "Coffee", "Wait"],
    },
    {"response": "- R.\nNEXT STEP:\n- \U0001f600 Chat: \U0001f389 party", "allowed_kinds": ["\U0001f600 Chat", "Wait"]},
    {"response": "- R.\nNEXT STEP:\n- Coffee:   \n- Coffee\n-Coffee: no space", "allowed_kinds": ["Coffee", "Wait"]},
    {"response": "- R.\nNEXT STEP:\n\u3000- Coffee: A.\u3000\n\x1f- Wait: B.\x1f", "allowed_kinds": ["Coffee", "Wait"]},
    {"response": "- R.\nNext step - Coffee: A.", "allowed_kinds": ["Coffee", "Wait"]},
    {"response": "NEXT STEP:\n- Coffee: A.", "allowed_kinds": ["Coffee", "Wait"]},
    {"response": "", "allowed_kinds": ["Coffee", "Wait"]},
    {"response": "- R.\nNEXT STEP:\n- Coffee: A.", "allowed_kinds": []},
    {"response": "- R.\n\u017fuggested next \u017ftep: Wait: B.", "allowed_kinds": ["Coffee", "Wait"]},
    {"response": "- R.\nNEXT STEP:\n- Lunch: X.\n- coffee: Y.\n- **Coffee**: Z.", "allowed_kinds": ["Coffee", "Wait"]},
]

BLOCK_CASES = [
    {
        "name": "recap, next step, button with Tracks and a default",
        "profile": {"page_id": "p1", "name": "J\u00f8rgen \u00c5se", "context_fields": [], "track_ids": ["t1"]},
        "recap": "- Recap one.\n- Recap two.",
        "answer": "Hej J\u00f8rgen! \U0001f600",
        "next_steps": [["M\u00f8de", "Catch up."], ["Wait", "Recently in touch."]],
        "tracks": [{"id": "t1", "name": "\u00c5rhus"}, {"id": "t2", "name": "Investors"}],
        "default_track_id": "t1",
        "interaction_types": ["M\u00f8de", "Call"],
    },
    {
        "name": "no recap, no next step, no Type options (no button)",
        "profile": {"page_id": "p1", "name": "Jane Doe", "context_fields": [], "track_ids": []},
        "recap": "",
        "answer": "Hi",
        "next_steps": [],
        "tracks": [],
        "default_track_id": None,
        "interaction_types": [],
    },
    {
        "name": "oversized draft with astral characters is truncated by code points",
        "profile": {"page_id": "p1", "name": "Jane Doe", "context_fields": [], "track_ids": []},
        "recap": "- Recap.",
        "answer": "x" * 2964 + "\U0001f600" * 10,
        "next_steps": [],
        "tracks": [],
        "default_track_id": None,
        "interaction_types": ["Coffee"],
    },
]


def profile_from(spec):
    return PersonProfile(
        page_id=spec["page_id"],
        name=spec["name"],
        context_fields=tuple(tuple(field) for field in spec["context_fields"]),
        track_ids=tuple(spec["track_ids"]),
    )


def interaction_from(spec):
    return InteractionSummary(
        date=spec["date"],
        type=spec["type"],
        title=spec["title"],
        notes=spec["notes"],
        track_ids=tuple(spec["track_ids"]),
    )


def track_from(spec):
    return TrackContext(name=spec["name"], purpose=spec["purpose"])


def constant_value(name):
    value = getattr(people_suggest, name)
    return list(value) if isinstance(value, tuple) else value


def build_fixture():
    prompts = []
    for case in PROMPT_CASES:
        profile = profile_from(case["profile"])
        interactions = [interaction_from(spec) for spec in case["interactions"]]
        person_tracks = [track_from(spec) for spec in case["person_tracks"]]
        other_tracks = [track_from(spec) for spec in case["other_tracks"]]
        prompts.append(
            {
                **case,
                "recap_prompt": build_recap_prompt(
                    profile, interactions, person_tracks, other_tracks, case["next_step_kinds"]
                ),
                "suggestion_prompt": build_suggestion_prompt(
                    profile, interactions, person_tracks, other_tracks
                ),
            }
        )

    splits = []
    for case in SPLIT_CASES:
        recap, next_steps = split_recap_and_next_steps(case["response"], case["allowed_kinds"])
        splits.append({**case, "recap": recap, "next_steps": [list(step) for step in next_steps]})

    blocks = []
    for case in BLOCK_CASES:
        profile = profile_from(case["profile"])
        next_step_text = format_next_steps([tuple(step) for step in case["next_steps"]])
        message = format_suggestion_message(profile.name, case["answer"])
        blocks.append(
            {
                **case,
                "reply_text": format_full_reply(case["recap"], message, next_step_text),
                "blocks": build_suggestion_blocks(
                    profile,
                    case["recap"],
                    message,
                    case["tracks"],
                    case["default_track_id"],
                    case["interaction_types"],
                    next_step_text,
                ),
            }
        )

    return {
        "meta": {"python": f"{sys.version_info.major}.{sys.version_info.minor}"},
        "constants": {name: constant_value(name) for name in CONSTANT_NAMES},
        "messages": [
            {
                "input": name,
                "person_not_found": people_suggest.person_not_found_message(name),
                "ambiguous": people_suggest.ambiguous_person_message(name),
            }
            for name in MESSAGE_NAMES
        ],
        "prompts": prompts,
        "splits": splits,
        "blocks": blocks,
    }


def render(fixture):
    return json.dumps(fixture, indent=1) + "\n"


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
            print("people_suggest fixture is out of date. Regenerate it with Python 3.12.")
            return 1
        print("people_suggest fixture is up to date.")
        return 0
    FIXTURE_PATH.parent.mkdir(parents=True, exist_ok=True)
    with FIXTURE_PATH.open("w", encoding="utf-8", newline="\n") as handle:
        handle.write(content)
    print(f"Wrote {FIXTURE_PATH.relative_to(REPO_ROOT)}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
