# Notion Tracks Schema

This document describes the schema of the Tracks data source, related to
Tasks, People, and Interactions. Re-confirmed directly from the live
Notion database.

## Properties

### Navn

Type: `title`

Required. The Track name shown by `/tasks list` and by the `/people
suggest` recap.

### Status

Type: `status`

Allowed values (as previously documented; not re-confirmed in the latest
schema pass):

* `Ikke startet` (To-do)
* `I gang` (In progress)
* `Afsluttet` (Complete)

This property is not used by `/tasks list` or `/people suggest`.

### Type

Type: `select`

Allowed values:

* `Engagement`
* `Channel`
* `Capability`
* `Outcome`

This property is not currently used by any command.

### Purpose

Type: `text`

Free-text purpose of the Track. Used by `/people suggest`, which reads it
from the already fetched Track page (no extra Notion request), truncates
it to `MAX_TRACK_PURPOSE_CHARS` (500) characters, and sends it to Gemini
as private context for the recap, next-step suggestion, and draft message.
It may therefore appear in Slack, paraphrased, through Gemini's output;
the draft-message prompt tells Gemini not to name a Track, quote a
Purpose, or present it as the user's goal. It must never be written to
logs. A missing, empty, or non-text `Purpose` is ignored, and the Track is
still used by name.

(This property was previously documented here as `Description`; the live
schema now shows `Purpose` instead — confirm whether it was renamed or
whether `Description` still exists separately.)

### Priority

Type: `select`

Allowed values, in display order:

1. `High`
2. `Medium`
3. `Low`

For a task with multiple resolved Tracks, `/tasks list` orders Track names by
this priority and then alphabetically by `Navn` within the same priority.
