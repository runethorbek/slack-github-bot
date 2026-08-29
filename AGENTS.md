# AGENTS.md

## Purpose

This repository implements a Slack-based assistant using GitHub Actions as runtime.

The system currently includes or is intended to include:

- Slack conversations
- Gemini for language understanding
- Notion Tasks integration
- Scheduled task summaries/reminders

The current task and its scope come from the relevant GitHub issue and linked specification, not from this file.

## Working principles

- Inspect existing code and conventions before changing them.
- Prefer small, independently verifiable end-to-end slices.
- Do not implement unrelated cleanup or speculative abstractions.
- Separate discovered facts from assumptions.
- Validate important assumptions before expanding the implementation.
- Keep external side effects explicit and constrained.
- Never expose secrets in code, logs, test output, or responses.
- Prefer the smallest change that satisfies the requested behavior.
- Preserve existing behavior unless the task explicitly requires changing it.

## Architecture

Current high-level flow:

Slack
→ Vercel webhook
→ GitHub repository_dispatch
→ GitHub Action
→ Python
→ Gemini / external services
→ Slack

The Vercel endpoint should remain a thin transport layer.

Application logic belongs in Python unless existing repository conventions clearly indicate otherwise.

Do not introduce new architectural layers, persistent state, or external infrastructure without explicit approval.

## Conversation model

One Slack thread represents one conversation/task.

The bot reconstructs conversation context from Slack rather than maintaining its own conversational state.

Do not introduce persistent conversational state unless required by the task and explicitly approved.

## AI boundaries

Gemini may:

- interpret user intent;
- extract constrained structured information;
- formulate responses.

Gemini must not directly execute arbitrary external API operations.

For external write operations:

1. Gemini may produce a constrained structured intent.
2. Python must validate the intent.
3. Application code performs the external side effect.

Do not allow model-generated text to determine arbitrary API endpoints, commands, credentials, or unrestricted parameters.

## Development workflow

For substantial changes:

1. Read the relevant GitHub issue and linked specification.
2. Inspect relevant code and current behavior.
3. Identify material assumptions or uncertainties.
4. Determine whether the requested work is already a sufficiently small slice.
5. If it is too broad or depends on an unvalidated assumption, propose a smaller tracer bullet before implementation.
6. Implement only the agreed scope.
7. Run appropriate tests and checks.
8. Inspect the resulting diff for unintended or unnecessary changes.
9. Report:
   - what changed;
   - verification performed;
   - assumptions made;
   - remaining risks or unresolved questions.

Do not treat a successful build or passing tests alone as proof that the requested behavior is correct.

## Escalation and stop conditions

Stop and ask for clarification or approval when:

- the issue/spec contains an unresolved product decision;
- implementation requires changing behavior outside the requested scope;
- an architectural change or new dependency appears necessary;
- persistent state or new infrastructure appears necessary;
- a destructive or externally visible write operation is required but was not explicitly requested;
- required credentials, APIs, schemas, or repository information are unavailable;
- tests or repository behavior contradict the assumptions in the issue/spec;
- the requested solution would weaken an existing security boundary;
- continuing would require guessing about behavior that materially affects correctness.

Do not resolve these situations by silently choosing an interpretation.

Small implementation details that are reversible and consistent with existing repository conventions do not require escalation.

## GitHub access

GitHub is the source of truth for issue and pull-request content.

Read-only GitHub operations may be used autonomously when needed to understand or verify a task, including:

- `gh issue view`
- `gh issue list`
- `gh label list`
- equivalent read-only PR inspection commands

The Codex sandbox may require approved host execution for these commands. Existing permission rules may allow approved read-only command patterns without further user interaction.

GitHub write operations require explicit user approval unless the current user request explicitly asks for that specific operation.

This includes:

- creating or editing issues;
- commenting on issues;
- closing or reopening issues;
- changing labels, assignees, or milestones;
- creating or editing pull requests;
- merging pull requests;
- pushing commits or branches.

Do not broaden a read-only GitHub permission into general `gh` write access.

If a GitHub write operation appears necessary but was not explicitly requested:

1. explain what operation is needed;
2. explain why;
3. state what external state it will change;
4. wait for approval.

Do not guess issue or PR contents if GitHub access fails.