# Notion Interactions Schema

This document describes the schema of the Interactions data source, as
reported directly from the live Notion database (copied from the Notion
UI, not re-derived from code).

## Properties

### Title of interaction

Type: `title`

Looked up by property type (`title`), not by this exact display name, so
the interaction title survives a rename in Notion.

### Date

Type: `date`

Required for recency sorting in `/people suggest` and for `/people due`
cadence evaluation. Looked up by the exact key `Date`.

### Type

Type: `select`

Allowed values include at least:

* `Walk`
* `LinkedIn Message`

(list not fully enumerated here)

Included in the context given to Gemini for `/people suggest`.

### People

Type: `relation`, relates to People

Looked up by the exact key `People`. Used both to find an Interaction's
owning Person and, on write, to link a newly created Interaction back to
a Person (`people_interaction.py`).

### Notes

Type: `text`

Looked up by the exact key `Notes`. Included in the context given to
Gemini for `/people suggest`.

### Track

Type: `relation`, relates to Tracks

Looked up by the exact key `Track`. Resolved to a Track name (bounded to
one Notion read per distinct Track id) and surfaced in the `/people
suggest` recap.
