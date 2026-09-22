# Notion People Schema

This document describes the schema of the People data source, as reported
directly from the live Notion database (copied from the Notion UI, not
re-derived from code).

## Properties

### Name

Type: `title`

Required. The Person's display name. Looked up by the exact key `Name`
(unlike Tasks, there is no type-based fallback for this property), so
renaming it in Notion would break Person resolution.

### LinkedIn

Type: `url`

Optional. Rendered as a clickable link in `/people due` output when
present; falls back to plain text if malformed.

### Relationship status

Type: `select`

Allowed values:

* `Target`
* `Developing`
* `Established`
* `Dormant`

Included in the context given to Gemini for `/people suggest`.

### Relationship intent

Type: `multi_select`

Allowed values include at least:

* `Executive`
* `AI`
* `Mentor`

(list not fully enumerated here; confirm the complete option set in Notion
if it matters for a future change)

Included in the context given to Gemini for `/people suggest`.

### Relationship Type

Type: `multi_select`

Allowed values include at least:

* `Peer`
* `Recruiter`
* `Manager`

Not currently read by any code path.

### Relationship context

Type: `multi_select`

Allowed values include at least:

* `Dalux`
* `MBA`
* `LinkedIn`

Not currently read by any code path. Note: this is unrelated to the
"Context:" recap section added for `/people suggest` (issue #15) — the
naming overlap is coincidental.

### Interests

Type: `multi_select`

Allowed values include at least:

* `Tech`
* `Children`

Included in the context given to Gemini for `/people suggest`.

### Expertise

Type: `multi_select`

Allowed values include at least:

* `AI`
* `Board Member`
* `SaaS`

Included in the context given to Gemini for `/people suggest`.

### Relationship strength

Type: `select`

Allowed values:

* `Weak`
* `Medium`
* `Strong`

Included in the context given to Gemini for `/people suggest`.

### Notes

Type: `text`

Included in the context given to Gemini for `/people suggest`.

### Contact cadence

Type: `select`

Allowed values:

* `1 month`
* `2 months`
* `3 months`
* `6 months`
* `12 months`

Drives `/people due`.

### Track Goal

Type: `relation`, relates to Tracks

Resolved (bounded to one Notion read per distinct Track id) and surfaced
in the `/people suggest` recap (issue #15).

### Why this person

**Removed from the live schema.** `people_suggest.py`'s
`PERSON_CONTEXT_PROPERTIES` and its tests still reference this property
name; since it no longer exists, that field is now always silently
omitted from the Gemini context (a missing property is treated as simply
absent, not an error) rather than raising anything. This is stale and
should be cleaned up in code — tracked separately from issue #15.
