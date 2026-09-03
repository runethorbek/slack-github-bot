# Task List Feature Spec

## Goal

Allow an authorized Slack channel to list tasks needing attention from one configured Notion Tasks data source by running `/tasks list`.

The command is read-only and deterministic. Task data must not be sent to Gemini.

## User-visible behavior

- `/tasks list` is accepted case-insensitively with surrounding whitespace. Missing, unknown, or extra arguments return concise usage guidance.
- The Slack transport immediately acknowledges every authenticated slash command with an empty `200` response; command-specific validation responses are sent ephemerally through Slack's response URL from Python.
- In the one authorized channel, the bot creates a public `/tasks list` root message and posts the result in its thread.
- Other channels receive a refusal, and Notion is not queried.
- Replies in a task-list thread do not invoke Gemini; users are directed to run a new supported command.

A task needs attention when its Status is not `Færdig` and either:

- Follow-up is missing; or
- Follow-up is overdue, today, or within the next seven calendar days in `Europe/Copenhagen`.

Tasks are ordered as follows:

1. Dated tasks by earliest Follow-up, then Priority, then Name.
2. Undated tasks by Priority, then Name.

Priority order is `High`, `Medium`, `Low`, then no priority.

The response shows at most 20 tasks. Each item includes a linked Name, Priority, Track name or fallback, and Follow-up state. Overdue tasks are identified explicitly. Status, Created, and Description are omitted.

Track handling is defined in the [Track Resolution Feature Spec](track-resolution.md).
Each task displays at most three Track entries; additional related Tracks are
summarized with an explicit `+N more` remainder.

If no tasks qualify, the bot responds `No tasks need attention right now.` Transient Notion failures are retried at most twice. Other Notion or schema failures produce a generic Slack error without exposing secrets or task contents. A malformed individual task is skipped, valid tasks are still shown, and the skipped count is reported.

## Smallest agreed tracer bullet

Extend the existing Slack-to-GitHub-Actions flow to:

1. Validate that the webhook request came from Slack.
2. Preserve and recognize the exact `/tasks list` command while leaving `/testbot` unchanged.
3. Reject unauthorized channels before accessing Notion.
4. Read from one configured Notion Tasks data source.
5. Select, order, and format qualifying tasks deterministically without Gemini.
6. Resolve Track names only for tasks that will be displayed.
7. Post the bounded result or a safe failure message to the command's Slack thread.

The command scans at most 500 qualifying tasks and displays at most 20. Below the scan limit it may report the exact remaining count. At the limit it reports only that more tasks exist and does not claim completeness.

## Acceptance criteria

1. An authentic `/tasks list` request in the authorized channel returns the correctly filtered and ordered list in a public Slack thread.
2. Overdue, today, exactly seven-days-away, and undated non-finished tasks are included.
3. Tasks eight days away and tasks with Status `Færdig` are excluded.
4. Missing Priority and Track values display their agreed fallbacks.
5. Task names link to their Notion pages, overdue dates are explicit, and no more than 20 tasks are displayed.
6. An unauthorized request does not access Notion, and an invalid Slack signature triggers no dispatch.
7. Empty results, malformed individual tasks, failed Track lookups, rate limits, permission errors, and schema errors follow the defined behavior.
8. `/testbot` continues to use Gemini unchanged, while task-list commands and their follow-ups never invoke Gemini.
9. Secrets, descriptions, and task contents are not written to logs.
10. Reaching the 500-task scan limit does not produce a false exact count or completeness claim.

## Verification

Automated checks cover:

- Slack signature validation and command routing.
- Authorization before Notion access.
- Copenhagen date boundaries, finished-task exclusion, eligibility, and deterministic ordering.
- Missing dates, priorities, and Tracks.
- Track lookup reuse and partial Track failures.
- The 20-result and 500-scan limits.
- Retry classification, safe failure handling, and Gemini non-invocation.
- Preservation of existing `/testbot` routing.

A deployed smoke test covers an authorized command, an unauthorized-channel attempt, successful Track resolution, and a controlled Notion-access failure.

## Known assumptions

- The Tasks schema matches `docs/notion-tasks-schema.md`, including the exact Status value `Ikke started`.
- The related Tracks data source follows [the Tracks schema](../notion-tracks-schema.md).
- The Notion integration can read both the Tasks and Tracks data sources.
- Follow-up values are date-only rather than timed dates or ranges.
- The authorized Slack channel, Notion data-source identifier, user-facing Notion URL, and required credentials are configured outside application code.
- Normal usage remains below 500 qualifying tasks. Above that limit, completeness and global ordering are not guaranteed.
- If Slack cannot be reached, the failure may only be visible in the runtime logs.

## Explicitly deferred concerns

- Notion writes.
- Scheduled summaries and reminders.
- Interactive pagination.
- Natural-language task commands.
- Conversational follow-ups in task-list threads.
- Per-user Notion authorization.
- Persistent idempotency and duplicate-response prevention.
- Moving execution out of GitHub Actions.
- Broader refactoring or unrelated production hardening.

## Implementation Tracking

Parent issue [#1](https://github.com/runethorbek/slack-github-bot/issues/1)
