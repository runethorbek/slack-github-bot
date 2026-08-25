# Notion Tasks Schema

This document describes the current schema of the Notion Tasks data source used by the Slack bot.

## Properties

### Name

Type: `title`

The task name.

### Created

Type: `date`

The date associated with when the task was created.

### Track

Type: `relation`

Relation to the relevant Track.

### Priority

Type: `select`

Allowed values:

* `High`
* `Medium`
* `Low`

### Description

Type: `text`

Free-text description of the task.

### Status

Type: `status`

Allowed values:

* `Ikke started`
* `I gang`
* `Færdig`

### Follow-up

Type: `date`

Optional follow-up date for the task.

