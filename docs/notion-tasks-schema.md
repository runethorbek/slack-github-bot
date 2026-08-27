# Notion Tasks Schema

This document describes the current schema of the Notion Tasks data source used by the Slack bot.

## Properties

### Name

Type: `title`

Notion property ID: `title`

Display name in the configured Danish data source: `Navn`

The task name.

`Name` is the domain term used by the application and feature spec. The bot
identifies the Notion property by its stable property ID, so the display name
may be localized or renamed without changing this mapping.

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

