# AGENTS.md

## Purpose

This repository implements a Slack-based assistant using GitHub Actions as runtime.

Current direction:
- Slack conversations
- Gemini for language understanding
- Notion Tasks integration
- Scheduled task summaries/reminders

## Working principles

- Inspect existing code before changing it.
- Prefer small end-to-end tracer bullets.
- Do not implement unrelated cleanup.
- Separate discovered facts from assumptions.
- Ask before making major architectural changes.
- Validate critical assumptions with working code before expanding the feature.
- Keep external side effects explicit and constrained.
- Never expose secrets in code or logs.

## Architecture

Slack
→ Vercel webhook
→ GitHub repository_dispatch
→ GitHub Action
→ Python
→ Gemini / external services
→ Slack

The Vercel endpoint should remain a thin transport layer.
Application logic belongs in Python.

## Conversation model

One Slack thread represents one conversation/task.

The bot reconstructs conversation context from Slack rather than maintaining its own conversational state unless persistent state becomes necessary.

## AI boundaries

Gemini may interpret user intent and formulate responses.

Gemini must not be allowed to execute arbitrary external API operations.

For write operations:
1. Gemini produces a constrained structured intent.
2. Python validates the intent.
3. Python performs the external side effect.

## Development workflow

For substantial features:

1. Inspect relevant code and current behavior.
2. State assumptions and uncertainties.
3. Propose the smallest meaningful tracer bullet.
4. Get agreement before broad implementation.
5. Implement.
6. Run appropriate tests/checks.
7. Review the diff for unnecessary changes.
8. Report what changed, verification performed, and remaining risks.

## Current priority

The next feature is read-only access to the Notion Tasks data source.

Do not implement Notion writes or scheduled reminders as part of that task unless explicitly requested.

## GitHub issue workflow

The GitHub CLI (`gh`) is installed and authenticated on the host environment.

In this Codex environment, GitHub CLI access requires host/elevated execution.

When GitHub issue or PR information is needed:
1. Do not first attempt `gh` inside the sandbox.
2. Request permission to run the required `gh` command on the host.
3. Use `gh` as the source of truth for issue and PR content.
4. Do not fall back to guessing, browser scraping, or alternate GitHub access methods unless `gh` fails after permission has been granted.

Examples:
- `gh issue view <number> --repo runethorbek/slack-github-bot`
- `gh issue list --repo runethorbek/slack-github-bot`
