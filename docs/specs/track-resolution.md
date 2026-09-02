# Track Resolution Feature Spec

## Goal

For each Task displayed by `/tasks list`, show the names of its related Tracks
without changing task eligibility, ordering, or the twenty-task display limit.

## Data contract

The related data source follows
[the Tracks schema](../notion-tracks-schema.md). The Task-side `Track`
property is a Notion relation containing zero or more Track page IDs.

## Behavior

- Resolve Track pages only after task selection has produced the displayed
  tasks.
- Fetch each distinct related Track page at most once per command execution.
- A Task with no related Track renders `Track: No track`.
- A Task with one resolved Track renders its `Navn`.
- A Task with multiple resolved Tracks renders every resolved Track name,
  ordered by `High`, `Medium`, `Low`, then alphabetically by `Navn` within a
  priority.
- If a related Track cannot be retrieved or lacks a usable `Navn`, retain the
  Task and render `Track unavailable` for that relation.
- Track resolution never sends Track or Task data to Gemini, and it makes no
  Notion writes.

## Constraints

- Do not widen Task selection or filtering behavior.
- Use command-local lookup reuse only; do not add persistent or generalized
  caching.
- Do not log Track or Task contents.
- Preserve `/testbot` behavior.

## Acceptance criteria

1. Zero, one, and multiple Track relations render correctly.
2. Multiple resolved Tracks follow the documented priority and name ordering.
3. A repeated Track ID causes one Track-page request per command execution.
4. A Track lookup failure or unusable Track name does not remove its Task.
5. Only displayed Tasks cause Track resolution.
6. `/tasks` handling does not invoke Gemini and `/testbot` remains unchanged.

## Verification

- Unit-test zero, one, and multiple related Tracks.
- Test priority ordering and alphabetical tie-breaking.
- Test reuse of repeated Track IDs.
- Test a partial Track lookup failure.
- Smoke-test `/tasks list` against known Task–Track relations in Notion and
  compare the Slack output with Notion.
