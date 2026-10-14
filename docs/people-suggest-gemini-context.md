# `/people suggest` — Gemini context

This page describes exactly what `/people suggest <person>` sends to Gemini,
where each piece comes from, and how it is bounded. The source of truth is
[`src/people-suggest.ts`](../src/people-suggest.ts); update this page when the
context changes.

To see the real prompts for a Person without calling Gemini or posting to
Slack, run
[`node scripts/preview-people-suggest-prompts.ts`](../scripts/preview-people-suggest-prompts.ts)
(see the README).

## Two Gemini calls

Each command makes two independent `generateText` calls, built from the same
context:

| Call | Builder | Purpose | Output handling |
| --- | --- | --- | --- |
| Recap (+ next step) | `buildRecapPrompt` | Private 2–4 bullet recap for the user, optionally followed by `NEXT STEP:` suggestions | Stripped, then split and validated by `splitRecapAndNextSteps` (see [Recap output](#recap-output)) |
| Draft message | `buildSuggestionPrompt` | Short reconnect message the user may send themselves | Stripped and prefixed with `Suggested message for <name>:` and a blank line (`formatSuggestionMessage`); its Slack section block is truncated to 3000 characters, ending in `…` |

### Recap output

- When next-step kinds were requested, the response is split at the first
  line that looks like the `NEXT STEP:` marker (matched leniently: any case,
  Markdown emphasis or a heading, `Suggested next step(s):`). Each line after
  it, and any text on the marker line itself, must have the form
  `<Kind>: <idea>` (optionally bulleted) with `<Kind>` exactly an allowed kind
  and a non-empty idea; anything else is dropped. At most 2 are kept.
- When no next step was requested (no Interaction Types loaded), or no marker
  line is found, the whole stripped response is shown as the recap, including
  any next-step text in it, unparsed.

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

- Resolved over at most `MAX_SCANNED_PEOPLE` People by comparing the typed
  name, trimmed of surrounding whitespace, with each Person's `Name`, whose
  whitespace runs are collapsed to single spaces; both sides are casefolded.
  Whitespace inside the typed name is not collapsed, so `Anders  Krog`
  (two spaces) does not match `Anders Krog`. Zero or multiple matches stop the
  command before Gemini is called.
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
- `Purpose` is whitespace-collapsed and limited to `MAX_TRACK_PURPOSE_CHARS`
  (500): a longer Purpose is cut to 499 characters followed by `…`.
- Tracks linked from the Person are "primary"; Tracks only linked from
  Interactions are "secondary". A Track name already listed is not repeated,
  so a name in the primary group is never listed again as secondary.
- A Track that fails to resolve (a Notion error such as a 403 or a 404, or a
  malformed page) is left out. A 401 on a Track page fetch is a credential
  failure: it aborts the whole command (the run fails after the
  `/people suggest <person>` root message, with no reply and no Gemini call).
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
| Track Purpose | 500 chars each (499 plus `…` when cut) |
| Next-step suggestions kept | 2 |
| Slack section output | 3000 chars (output only, not prompt) |

Total prompt size is therefore not capped explicitly; it is bounded only by the
counts above plus the length of Person fields and Interaction notes.

## Not included

- Interactions older than the newest 5, and Tracks linked only from them.
- Person and Track page bodies, Notion comments.
- Slack thread history.

These are the candidate levers if recaps turn out to miss context (issue #24).
