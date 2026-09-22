"""One-off dev utility: dump live Notion data source schemas to local files.

Read-only. Calls Notion's "retrieve a data source" endpoint for whichever of
People / Interactions / Tasks / Tracks have a data source id configured, and
writes each response's ``properties`` to schema-dump/<name>.json so the repo's
docs/notion-*-schema.md files can be written or corrected against the real
schema instead of guessed from code.

Usage (PowerShell):
    $env:NOTION_API_KEY = "..."
    $env:NOTION_PEOPLE_DATA_SOURCE_ID = "..."
    $env:NOTION_INTERACTIONS_DATA_SOURCE_ID = "..."
    $env:NOTION_TASKS_DATA_SOURCE_ID = "..."
    $env:NOTION_TRACKS_DATA_SOURCE_ID = "..."   # not used by the app itself;
                                                  # find it via the Tracks
                                                  # database's Notion URL/share
                                                  # link if not already set
    python scripts/fetch_notion_schema.py

Only data sources whose env var is set are fetched; the rest are skipped.
Nothing is printed except progress lines naming which sources were fetched
or skipped -- the API key is never logged, and the dumped files contain
schema (property names/types/options) only, never row data.
"""

import json
import os
import sys
from pathlib import Path

import requests

NOTION_API_VERSION = "2025-09-03"

DATA_SOURCES = {
    "people": "NOTION_PEOPLE_DATA_SOURCE_ID",
    "interactions": "NOTION_INTERACTIONS_DATA_SOURCE_ID",
    "tasks": "NOTION_TASKS_DATA_SOURCE_ID",
    "tracks": "NOTION_TRACKS_DATA_SOURCE_ID",
}

OUTPUT_DIR = Path(__file__).resolve().parent.parent / "schema-dump"


def main():
    api_key = os.environ.get("NOTION_API_KEY")
    if not api_key:
        print("NOTION_API_KEY is not set; nothing to do.", file=sys.stderr)
        return 1

    headers = {
        "Authorization": f"Bearer {api_key}",
        "Notion-Version": NOTION_API_VERSION,
    }

    OUTPUT_DIR.mkdir(exist_ok=True)

    fetched_any = False
    for name, env_var in DATA_SOURCES.items():
        data_source_id = os.environ.get(env_var)
        if not data_source_id:
            print(f"Skipping {name}: {env_var} is not set.")
            continue

        response = requests.get(
            f"https://api.notion.com/v1/data_sources/{data_source_id}",
            headers=headers,
            timeout=10,
        )
        response.raise_for_status()
        properties = response.json().get("properties", {})

        output_path = OUTPUT_DIR / f"{name}.json"
        output_path.write_text(json.dumps(properties, indent=2, ensure_ascii=False))
        print(f"Wrote {output_path} ({len(properties)} properties)")
        fetched_any = True

    if not fetched_any:
        print("No data source ids were set; nothing fetched.", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
