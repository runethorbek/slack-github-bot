# Notion Tracks Schema

This document describes the schema of the Tracks data source related to Tasks.

## Properties

### Navn

Type: `title`

Required. The Track name shown by `/tasks list`.

### Status

Type: `status`

Allowed values:

* `Ikke started` (To-do)
* `I gang` (In progress)
* `Afsluttet` (Complete)

This property is not used by `/tasks list`.

### Description

Type: `text`

This property is not used by `/tasks list` and must not be sent to Slack or
written to logs.

### Priority

Type: `select`

Allowed values, in display order:

1. `High`
2. `Medium`
3. `Low`

For a task with multiple resolved Tracks, `/tasks list` orders Track names by
this priority and then alphabetically by `Navn` within the same priority.
