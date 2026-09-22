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

* `Ikke started` (To-do)
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

Free-text purpose of the Track. Not currently used by any command; must
not be sent to Slack or written to logs if that changes, consistent with
this data source's other free-text fields.

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
