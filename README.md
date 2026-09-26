# Slack → GitHub Actions → Gemini Bot

A Slack bot that uses:

* Slack as the user interface
* Vercel as a lightweight webhook endpoint
* GitHub Actions as the runtime/orchestration layer
* Python for the bot logic
* Notion as the read-only source of Tasks, Tracks, People, and Interactions data
* Google Gemini for open-ended conversation and for drafting suggested messages
* Slack threads as conversation context

The goal of the project is to explore a simple event-driven AI integration without running a permanent backend service.

## Architecture

```text
Slack
  │
  │ /testbot <message>  │  /tasks list  │  /people due | suggest <person>  │  button click
  ▼
Vercel Function
/api/slack
  │
  │ repository_dispatch
  ▼
GitHub Actions
  │
  ▼
main.py
  │
  ├── /testbot, thread replies → Gemini conversation
  │
  ├── /tasks list            → read-only Notion Tasks + Tracks lookup
  │
  └── /people due | suggest  → read-only Notion People + Interactions lookup
                                 (suggest drafts text via Gemini)
  │
  ▼
Slack thread
```

A channel conversation is started using:

```text
/testbot <message>
```

The bot creates a real Slack message and uses that message as the root of a new thread.

An authorized root DM is itself the root of a new conversation. The bot replies beneath it with a deterministic acknowledgement; DM history is not loaded and Gemini is not invoked.

Replies written by the user inside that thread are received through Slack Event Subscriptions. Each reply triggers another GitHub Action run.

The Python process is stateless. Instead of storing conversation state itself, it retrieves the Slack thread and uses it as the conversation history.

`/tasks` and `/people` are owned, deterministic command families that never reach the Gemini conversation path (`/people suggest` is the one exception that calls Gemini, and only to draft text — see [Gemini](#gemini)).

## Repository structure

```text
.
├── api/
│   ├── slack.js
│   └── slack-request.js
├── .github/
│   └── workflows/
│       ├── attention-summary.yml
│       └── slack-message.yml
├── main.py
├── attention_summary.py
├── tasks_list.py
├── people_due.py
├── people_suggest.py
├── slack_authorization.py
├── tests/
├── package.json
├── requirements.txt
├── docs/
│   ├── notion-tasks-schema.md
│   ├── notion-tracks-schema.md
│   ├── ubiquitous-language.md
│   └── specs/
│       ├── tasks-list.md
│       └── track-resolution.md
└── README.md
```

### `api/slack.js`

Vercel Function responsible for receiving requests from Slack. It delegates request handling to `api/slack-request.js` and triggers a GitHub `repository_dispatch` event with the parsed payload.

The Vercel function deliberately contains very little application logic. Its primary responsibility is transporting events from Slack to GitHub.

### `api/slack-request.js`

Contains the authenticated transport handling used by the Vercel function.

Before parsing or dispatching a request, it verifies Slack's `X-Slack-Signature` using the exact raw request body and `SLACK_SIGNING_SECRET`. Requests with a missing, invalid, or more-than-five-minute-old timestamp are rejected. The signing secret stays in Vercel and is never forwarded to GitHub Actions.

It handles three request shapes:

1. **Slash commands** (`/testbot`, `/tasks`, `/people`) — preserves the command, text, and response URL in the dispatch payload, and returns an immediate empty acknowledgement. Python uses the response URL for ephemeral validation/refusal responses.
2. **Events API callbacks** (message events and URL verification) — forwards thread replies and authorized root DMs; ignores the bot's own messages and ordinary top-level channel messages.
3. **Block Kit interactivity** (button clicks) — a "Suggest message" button attached to a `/people due` result is dispatched as if the user had typed `/people suggest <name>`, reusing the exact same Person-resolution and Gemini-drafting path as the typed command.

### `slack-message.yml`

GitHub Actions workflow triggered by:

```yaml
repository_dispatch:
  types: [slack_message]
```

The workflow:

1. Checks out the repository
2. Configures Python
3. Installs dependencies
4. Masks and exports the Slack response URL separately so it never appears in a workflow `env:` mapping (which GitHub Actions would log)
5. Passes Slack command, event, and configuration values to `main.py`
6. Runs the Python bot

### `main.py`

Entry point and Slack transport glue. It authorizes and routes requests in this order, before any of them can reach the Gemini conversation path:

1. Authorized-DM tracer — a deterministic acknowledgement for a root DM from the one authorized Slack user.
2. `/tasks` and `/people` authorization — both command families are restricted to the configured Tasks channel or the authorized user's DM; unauthorized requests are refused without touching Notion.
3. `/people` — delegates to [`people_due.py`](#people_duepy).
4. `/tasks` — delegates to [`tasks_list.py`](#tasks_listpy).

Anything not handled above falls through to the Gemini conversation path:

For a new `/testbot` request it:

1. Creates a real Slack message
2. Uses its Slack timestamp as the thread ID
3. Sends the request to Gemini
4. Posts Gemini's response as a reply in the thread

For subsequent Slack thread replies it:

1. Receives `channel_id` and `thread_ts`
2. Retrieves the complete Slack thread
3. Identifies user and assistant messages
4. Sends the conversation history to Gemini
5. Posts Gemini's answer back into the same thread

### `tasks_list.py`

Implements `/tasks list`, fully deterministic and Gemini-free:

1. Accepts `/tasks list` case-insensitively, allowing surrounding whitespace; anything else returns usage guidance.
2. Reads a bounded set (up to 500) of non-finished tasks from the configured Notion Tasks data source, with retry on transient Notion failures.
3. Filters to tasks needing attention (no follow-up date, or a follow-up within 7 days), sorts by follow-up date then priority then name, and caps the displayed list at 20.
4. Resolves each distinct related Track at most once, so a task's Track name and priority can be shown without duplicate Notion lookups.
5. Posts a public `/tasks list` root message and replies with the formatted task list.

Malformed individual task or Track records are skipped rather than failing the whole command; an incomplete scan is reported honestly instead of being presented as an empty or complete result.

### `people_due.py`

Implements `/people due` and routes `/people suggest <person>`, fully deterministic on the Notion-access side:

1. Reads every Person with a configured Contact cadence, and every dated Interaction on or before today, each in one bounded, paginated scan.
2. Groups Interactions by related Person locally, then evaluates each Person's cadence (no previous interaction, not due, due today, or overdue) against calendar-month arithmetic.
3. Sorts due People by next-contact-due date then name, caps the displayed list at 20, and posts a threaded reply as both formatted text and Block Kit sections.
4. Each due Person's block includes a "Suggest message" button (see `api/slack-request.js`) that invokes `/people suggest <name>` on click.

`/people suggest <person>` resolves the named Person by an exact, case-insensitive Name match (refusing to guess when zero or multiple People match), reads their context fields and up to 5 recent Interactions, and asks Gemini (via an injected `generate_text` callable) to draft a short reconnect message using only that supplied context. Gemini never accesses Notion directly and never decides who to contact.

### `attention-summary.yml` and `attention_summary.py`

A separate workflow runs Monday and Thursday at 06:00 UTC (`0 6 * * 1,4`) and can also be started manually via `workflow_dispatch`. GitHub may delay scheduled runs, and disables schedules after 60 days without repository activity.

`attention_summary.py` sends one private DM to `AUTHORIZED_SLACK_USER_ID` summarizing what needs attention, reusing the exact `/tasks list` eligibility and `/people due` cadence logic so it matches those commands on the same day:

* Tasks with a Follow-up date: at most 5 listed, then `+N more — run /tasks list`.
* Tasks without a Follow-up date: a count only.
* Due People: at most 5 listed as plain text (no Suggest button), then `+N more — run /people due`.

Nothing is sent when nothing needs attention. An incomplete scan counts as something to report, with the same "more may need attention" line the commands use; skipped malformed rows are noted within a shown section but never trigger a DM on their own.

Any failure fails the run with a secret-free `::error::` annotation, so an unwatched scheduled run stays visible. If one source fails, the other section is still sent with an "unavailable" line when it has something to report. If both fail, or the Slack send fails, nothing is sent. Gemini is not used, and only error types, HTTP status codes and missing setting names are logged.

### `slack_authorization.py`

Shared authorization check for `/tasks` and `/people`: a request is authorized if it comes from the configured Tasks Slack channel, or from the one authorized user's DM.

## Slack configuration

Create a Slack App and configure these slash commands:

```text
/testbot
/tasks
/people
```

The Request URL for slash commands, Event Subscriptions, and Interactivity should all point to the deployed Vercel function:

```text
https://<your-vercel-project>.vercel.app/api/slack
```

Enable **Interactivity & Shortcuts** with the same Request URL so the `/people due` "Suggest message" button click reaches the bot.

### Required Bot Token Scopes

The app currently uses:

```text
commands
chat:write
channels:history
```

`commands` allows the slash commands. `chat:write` allows the bot to create messages and replies. `channels:history` allows the bot to retrieve messages from public channels and their threads.

To receive direct-message events, also add:

```text
im:history
```

`chat:write` is sufficient to reply in an existing DM and to post the scheduled attention summary (sent with `chat.postMessage` to the authorized user's ID, which lands in the app's DM with that user), so `im:write` is not required. Reinstall or re-authorize the Slack app after adding `im:history` so the installed bot token receives the new scope.

The bot must also be invited to the Slack channel where it is being used.

For example:

```text
/invite @GitHub Test Bot
```

## Slack Event Subscriptions

Enable Event Subscriptions in the Slack App using the same Vercel endpoint as above.

Subscribe to the bot event:

```text
message.channels
message.im
```

`message.channels` preserves replies inside existing channel threads. `message.im` allows root messages and thread replies in the app's direct-message conversation to reach the bot.

The Vercel function ignores messages generated by the bot itself to prevent an infinite loop:

```text
Bot response
→ Slack event
→ GitHub Action
→ Bot response
→ Slack event
→ ...
```

It also ignores ordinary top-level channel messages. Channel conversations must still be started explicitly using `/testbot`; an authorized root DM starts a separate DM conversation.

## Vercel configuration

The repository can be connected directly to a Vercel project.

Vercel automatically exposes:

```text
api/slack.js
```

as:

```text
https://<project>.vercel.app/api/slack
```

Configure the following environment variables in Vercel:

```text
GITHUB_OWNER
GITHUB_REPO
GITHUB_TOKEN
SLACK_SIGNING_SECRET
```

Example:

```text
GITHUB_OWNER=runeivan
GITHUB_REPO=slack-github-bot
```

`GITHUB_TOKEN` must be stored as a secret and must have permission to trigger `repository_dispatch` on the repository.

`SLACK_SIGNING_SECRET` must be stored as a secret and match the signing secret for the Slack app that sends requests to the endpoint.

Do not commit the GitHub token to the repository.

## GitHub Secrets

Configure these repository secrets under:

```text
Settings
→ Secrets and variables
→ Actions
```

### `GEMINI_API_KEY`

API key used by the Python application to call Google Gemini.

### `SLACK_BOT_TOKEN`

Slack Bot User OAuth Token. It normally starts with:

```text
xoxb-
```

### `NOTION_API_KEY`

API key for read-only access to the configured Notion data sources.

### `NOTION_TASKS_DATA_SOURCE_ID`

The ID of the Notion Tasks data source queried by `/tasks list`.

### `NOTION_PEOPLE_DATA_SOURCE_ID`

The ID of the Notion People data source queried by `/people due` and `/people suggest`.

### `NOTION_INTERACTIONS_DATA_SOURCE_ID`

The ID of the Notion Interactions data source queried by `/people due` and `/people suggest`.

### `NOTION_TRACKS_DATA_SOURCE_ID`

The ID of the Notion Tracks data source. Queried to populate the Track selector in the "Add interaction" modal and to validate a submitted Track id before it is written to an Interaction. If unset, the Track selector is simply omitted from the modal.

### `TASKS_SLACK_CHANNEL_ID`

The Slack channel ID authorized to use `/tasks` and `/people`.

### `AUTHORIZED_SLACK_USER_ID`

The single Slack member ID authorized to use the private DM tracer and to use `/tasks`/`/people` from a DM. In Slack, open the member's profile, choose *More*, and select *Copy member ID*; use the ID value (typically beginning with `U`), not the display name.

Never commit any token, API key, or data-source identifier to the repository.

## GitHub Action environment

The workflow passes information from the `repository_dispatch` payload to Python.

Example:

```yaml
env:
  SLACK_COMMAND: ${{ github.event.client_payload.command }}
  SLACK_TEXT: ${{ github.event.client_payload.text }}
  SLACK_CHANNEL_ID: ${{ github.event.client_payload.channel_id }}
  SLACK_USER_ID: ${{ github.event.client_payload.user_id }}
  SLACK_EVENT_TS: ${{ github.event.client_payload.event_ts }}
  SLACK_THREAD_TS: ${{ github.event.client_payload.thread_ts }}
  SLACK_CHANNEL_TYPE: ${{ github.event.client_payload.channel_type }}
  SLACK_EVENT_TYPE: ${{ github.event.client_payload.slack_event_type }}
  SLACK_BOT_TOKEN: ${{ secrets.SLACK_BOT_TOKEN }}
  AUTHORIZED_SLACK_USER_ID: ${{ secrets.AUTHORIZED_SLACK_USER_ID }}
  GEMINI_API_KEY: ${{ secrets.GEMINI_API_KEY }}
  NOTION_API_KEY: ${{ secrets.NOTION_API_KEY }}
  NOTION_PEOPLE_DATA_SOURCE_ID: ${{ secrets.NOTION_PEOPLE_DATA_SOURCE_ID }}
  NOTION_INTERACTIONS_DATA_SOURCE_ID: ${{ secrets.NOTION_INTERACTIONS_DATA_SOURCE_ID }}
  NOTION_TASKS_DATA_SOURCE_ID: ${{ secrets.NOTION_TASKS_DATA_SOURCE_ID }}
  NOTION_TRACKS_DATA_SOURCE_ID: ${{ secrets.NOTION_TRACKS_DATA_SOURCE_ID }}
  TASKS_SLACK_CHANNEL_ID: ${{ secrets.TASKS_SLACK_CHANNEL_ID }}
```

The workflow reads the response URL from GitHub's event payload, masks it, and exports it to Python as `SLACK_RESPONSE_URL` in a separate step. Do not pass it directly through a workflow `env:` mapping, because GitHub Actions logs environment values.

## Conversation model

The project uses a simple convention:

```text
One Slack thread = one task / conversation
```

`/tasks` and `/people` are exceptions to the Gemini conversation path: they are owned command families.

* `/tasks list` — a public root message with a formatted, Track-annotated task list in a threaded reply.
* `/people due` — a threaded reply listing People due for contact, each with a "Suggest message" button.
* `/people suggest <person>` — a threaded reply with a Gemini-drafted reconnect message for that Person.

Invalid and unauthorized `/tasks`/`/people` requests return a deterministic response and do not access Notion or Gemini.

For the Gemini conversation path, the first user message defines the task, and later user messages are considered follow-up questions, answers, or clarifications.

Example:

```text
/testbot Give me three advantages of Python

GitHub Test Bot
💬 Give me three advantages of Python

    ↳ 1. Easy to read
      2. Large ecosystem
      3. Strong community

User:
    ↳ Explain number 2

GitHub Test Bot:
    ↳ Python has a large ecosystem because...
```

Python retrieves the entire Slack thread before asking Gemini to answer the latest message. This means the application itself does not currently maintain persistent conversation state.

## Gemini

The project currently uses a Gemini Flash-Lite model to keep development and experimentation inexpensive.

Gemini is used in two, deliberately separated ways:

* **Open-ended conversation** (`/testbot` and thread replies) — the prompt explains that Gemini is participating in an existing Slack thread and instructs it to treat the first message as the original task, interpret later messages as follow-ups, use previous messages as context, respond to the latest user message, avoid restarting the conversation, and format responses for Slack rather than standard Markdown.
* **Constrained drafting** (`/people suggest <person>`) — Gemini receives only the bounded Person context and recent Interactions that `people_suggest.py` assembles deterministically, and is asked only to draft message text. It never chooses which Person to contact, never accesses Notion, and never performs a side effect; the user reviews and sends the draft themselves.

Gemini is never given the ability to decide which external API to call or to generate arbitrary API requests. `/tasks` and `/people due` do not send Notion data or command input to Gemini at all.

## Slack formatting

Slack uses its own `mrkdwn` formatting rather than standard Markdown.

The bot therefore asks Gemini to avoid constructs such as:

```text
# Markdown headings

| Markdown | Tables |
|----------|--------|
```

and instead prefer Slack-compatible formatting such as:

```text
*bold*
_italic_
`code`

• simple lists
```

## Development flow

A useful way to test the integration is to verify each layer independently.

### Test GitHub repository dispatch

A manual `repository_dispatch` request should start the GitHub Action.

### Test Vercel

From PowerShell:

```powershell
Invoke-WebRequest `
    -Method Post `
    -Uri "https://<your-project>.vercel.app/api/slack" `
    -ContentType "application/x-www-form-urlencoded" `
    -Body "text=test&channel_id=C123&user_id=U123"
```

A working endpoint should return HTTP `200`.

### Test Slack slash commands

```text
/testbot Hello
/tasks list
/people due
/people suggest <person>
```

`/testbot` should produce:

```text
Slack
→ Vercel
→ GitHub Action
→ Python
→ Gemini
→ Slack thread
```

`/tasks list` and `/people due`/`suggest` should produce a threaded reply without invoking Gemini (except `/people suggest`, which drafts its reply text via Gemini).

### Test conversation context

Reply inside a `/testbot`-generated Slack thread:

```text
Can you elaborate?
```

A second GitHub Action should start.

The bot does not print reconstructed conversations to GitHub Actions logs.

### Run the automated test suite

```bash
pip install -r requirements.txt
python -m pytest

npm install
npm test
```

## Security notes

This project is currently intended as an experiment.

Before treating it as a production service, additional hardening should be added.

In particular:

* Slack request signatures are validated at the Vercel boundary using the Slack Signing Secret, including a five-minute replay window
* Do not log secrets or Slack response URLs
* Minimize GitHub token permissions
* Restrict Slack App OAuth scopes
* Add handling for duplicate Slack events
* Add better retry and error handling
* Consider limits on Gemini input size
* Avoid logging complete Slack conversations

The `/tasks list` and `/people due` paths are read-only: both authorize the Slack channel or DM before constructing a Notion request, and neither sends task/people-command input or Notion data to Gemini. `/people suggest` also stays read-only against Notion; it sends only deliberately bounded Person/Interaction context to Gemini, and Gemini's output is posted to Slack for the user to act on, never used to trigger a side effect itself.

## Current limitations

The application currently relies on GitHub Actions for each interaction.

That works well for experimentation, but it introduces latency because every Slack message starts a new Actions runner.

For a production conversational bot, a persistent service or serverless execution environment would likely provide lower latency.

The current design intentionally favors simplicity and visibility over response speed.

## Possible next steps

Potential extensions include richer read-only behavior and, separately, carefully constrained write actions — for example, allowing Gemini to interpret a request like "Create a task called 'Fix login timeout'" or "Set the Phoenix project priority to High."

For write operations, Gemini should not be allowed to generate arbitrary Notion API requests directly. A safer approach is for Gemini to return a structured, constrained intent, for example:

```json
{
  "action": "create_task",
  "parameters": {
    "title": "Fix login timeout",
    "priority": "High"
  }
}
```

Python can then validate the requested action before calling the Notion API, exactly as `/people suggest` already keeps Gemini responsible only for interpreting/drafting while application code stays responsible for authorization and side effects.
