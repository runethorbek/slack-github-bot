# `/people suggest` — Gemini context

This page describes exactly what `/people suggest <person>` sends to Gemini,
where each piece comes from, and how it is bounded. The source of truth is
[`people_suggest.py`](../people_suggest.py); update this page when the context
changes.

To see the real prompts for a Person without calling Gemini or posting to
Slack, run `scripts/preview_people_suggest_prompts.py` (see the README).

## Two Gemini calls

Each command makes two independent `generate_text` calls, built from the same
context:

| Call | Builder | Purpose | Output handling |
| --- | --- | --- | --- |
| Recap (+ next step) | `build_recap_prompt` | Private 2–4 bullet recap for the user, optionally followed by `NEXT STEP:` suggestions | Split and validated by `split_recap_and_next_steps`; invalid next-step kinds dropped, max 2 kept |
| Draft message | `build_suggestion_prompt` | Short reconnect message the user may send themselves | Posted as-is (Slack block truncated at 3000 chars) |

Gemini receives only the text described below. It never accesses Notion,
never chooses the Person, and its output never triggers a write.

## Prompt structure

```
<system instruction>          SUGGESTION_SYSTEM_INSTRUCTION | RECAP_SYSTEM_INSTRUCTION
                              | RECAP_WITH_NEXT_STEP_SYSTEM_INSTRUCTION
<track rules>                 only if at least one Track resolved:
                              SUGGESTION_TRACK_RULES | RECAP_TRACK_FOCUS_RULES

PERSON CONTEXT:
Name: <name>
<Property>: <value>           one line per non-empty context property

RECENT INTERACTIONS:
- Date: …; Type: …; Title: …; Notes: …
                              or "No previous Interactions are recorded."

RELEVANT TRACKS:              only if at least one Track resolved
Person's Tracks (primary focus):
- <Track name>
  Purpose: <purpose>
Other Tracks from recent Interactions (secondary):
- <Track name>
  Purpose: <purpose>

ALLOWED NEXT STEP KINDS:      recap call only, only if Interaction Types loaded
- <live Interaction Type option>
- Wait
```

Empty sections and empty fields are omitted rather than sent as blanks.

## Sources

### Person (People data source)

- Resolved by exact, case-insensitive `Name` match over at most
  `MAX_SCANNED_PEOPLE` People. Zero or multiple matches stop the command
  before Gemini is called.
- Context properties, in this order (`PERSON_CONTEXT_PROPERTIES`):
  `Why this person`, `Relationship intent`, `Relationship status`,
  `Relationship strength`, `Interests`, `Expertise`, `Notes`.
- Only `rich_text`, `select` and `multi_select` values are read. Other
  property types and the page body are not included.
- No length cap on these values.

### Interactions (Interactions data source)

- One query: related to this Person, `Date` set and on or before today
  (Copenhagen), sorted by `Date` descending, `page_size =
  MAX_SUGGESTION_INTERACTIONS` (5). No pagination.
- Per Interaction: `Date`, `Type`, title, `Notes` (in full, no length cap).
  Interactions with none of these are skipped.
- Older Interactions are not included at all (see issue #24).

### Tracks

- Track ids are collected from the Person's `Track Goal` relation first, then
  from the fetched Interactions' Track relation; deduplicated and capped at
  `MAX_SUGGESTION_TRACKS` (5).
- One `GET /v1/pages/{id}` per Track. Name and `Purpose` come from that page.
- `Purpose` is whitespace-collapsed and truncated to
  `MAX_TRACK_PURPOSE_CHARS` (500).
- Tracks linked from the Person are "primary"; Tracks only linked from
  Interactions are "secondary". A Track that fails to resolve is left out.
- Track page body and comments are not read.

### Allowed next-step kinds

- The live Interaction `Type` options plus `Wait`. If the options cannot be
  loaded, no next step is requested and the recap prompt has no next-step
  part.

## Bounds summary

| What | Bound |
| --- | --- |
| People scanned for name match | `MAX_SCANNED_PEOPLE` |
| Interactions | 5 newest, one query |
| Interaction notes | unbounded (full text) |
| Person context values | unbounded (full text) |
| Tracks | 5, one GET each |
| Track Purpose | 500 chars each |
| Next-step suggestions kept | 2 |
| Slack section output | 3000 chars (output only, not prompt) |

Total prompt size is therefore not capped explicitly; it is bounded only by the
counts above plus the length of Person fields and Interaction notes.

## Not included

- Interactions older than the newest 5, and Tracks linked only from them.
- Person and Track page bodies, Notion comments.
- Slack thread history.

These are the candidate levers if recaps turn out to miss context (issue #24).
