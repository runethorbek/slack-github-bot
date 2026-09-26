"""One-off dev utility: print the exact Gemini prompts `/people suggest` builds.

Runs the real `handle_people_suggest` code path against live Notion data, but
with Gemini and Slack replaced by local stubs: nothing is sent to Gemini and
nothing is posted to Slack. Notion is only read (the same queries and page
fetches the command makes). The captured prompts -- the recap/next-step prompt
and the draft-message prompt -- are printed to this terminal only.

Use it to check what Track context (names and Purposes) actually reaches
Gemini for a given Person.

Usage (PowerShell):
    $env:NOTION_API_KEY = "..."
    $env:NOTION_PEOPLE_DATA_SOURCE_ID = "..."
    $env:NOTION_INTERACTIONS_DATA_SOURCE_ID = "..."
    $env:NOTION_TRACKS_DATA_SOURCE_ID = "..."   # optional; only affects the
                                                  # Track picker, not the prompts
    python scripts/preview_people_suggest_prompts.py "Anders Krog-Meyer"

The output contains private Notion data (Person context, Interaction notes,
Track Purposes). Do not paste it anywhere public or commit it. The API key is
never printed.
"""

import os
import sys
from pathlib import Path

import requests

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from people_suggest import handle_people_suggest  # noqa: E402

REQUIRED_ENV_VARS = (
    "NOTION_API_KEY",
    "NOTION_PEOPLE_DATA_SOURCE_ID",
    "NOTION_INTERACTIONS_DATA_SOURCE_ID",
)

PROMPT_LABELS = (
    "RECAP / NEXT-STEP PROMPT",
    "DRAFT-MESSAGE PROMPT",
)


def main():
    if len(sys.argv) != 2 or not sys.argv[1].strip():
        print(
            'Usage: python scripts/preview_people_suggest_prompts.py "<Person name>"',
            file=sys.stderr,
        )
        return 2

    missing = [name for name in REQUIRED_ENV_VARS if not os.environ.get(name)]
    if missing:
        print(f"Missing environment variables: {', '.join(missing)}", file=sys.stderr)
        return 1

    # Purposes may contain characters (e.g. the truncation "…") that a
    # legacy Windows console encoding cannot print.
    sys.stdout.reconfigure(encoding="utf-8")

    prompts = []
    slack_messages = []

    def capture_prompt(prompt):
        prompts.append(prompt)
        return "- (dry run: Gemini not called)"

    def capture_slack_message(message, thread_ts=None, blocks=None):
        slack_messages.append(message)
        return {"ts": "dry-run"}

    handle_people_suggest(
        sys.argv[1].strip(),
        capture_slack_message,
        requests.post,
        capture_prompt,
        os.environ,
        notion_get=requests.get,
    )

    if not prompts:
        # The command stopped before calling Gemini (Person not found,
        # ambiguous, or a Notion failure); show what it would have posted.
        print("No Gemini prompts were built. The command would have replied:\n")
        for message in slack_messages[1:]:
            print(message)
        return 1

    for label, prompt in zip(PROMPT_LABELS, prompts):
        print(f"{'=' * 20} {label} {'=' * 20}")
        print(prompt)
        print()
    return 0


if __name__ == "__main__":
    sys.exit(main())
