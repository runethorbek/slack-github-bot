# Slack → GitHub Actions → Gemini Bot

A small experimental Slack bot that uses:

* Slack as the user interface
* Vercel as a lightweight webhook endpoint
* GitHub Actions as the runtime/orchestration layer
* Python for the bot logic
* Google Gemini for AI responses
* Slack threads as conversation context

The goal of the project is to explore a simple event-driven AI integration without running a permanent backend service.

## Architecture

```text
Slack
  │
  │ /testbot <message>
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
  ├── Read Slack thread
  │
  ├── Send conversation to Gemini
  │
  └── Post response to Slack
  │
  ▼
Slack thread
```

A new conversation is started using:

```text
/testbot <message>
```

The bot creates a real Slack message and uses that message as the root of a new thread.

Replies written by the user inside that thread are received through Slack Event Subscriptions. Each reply triggers another GitHub Action run.

The Python process is stateless. Instead of storing conversation state itself, it retrieves the Slack thread and uses it as the conversation history.

## Repository structure

```text
.
├── api/
│   ├── slack.js
│   └── slack-request.js
├── .github/
│   └── workflows/
│       └── slack-message.yml
├── main.py
├── tasks_list.py
├── tests/
├── package.json
├── docs/
│   ├── specs/tasks-list.md
│   └── notion-tasks-schema.md
└── README.md
```

### `api/slack.js`

Vercel Function responsible for receiving requests from Slack.

It handles two types of requests:

1. Slack slash commands
2. Slack message events

It forwards the relevant payload to GitHub using a `repository_dispatch` event.

The Vercel function deliberately contains very little application logic. Its primary responsibility is transporting events from Slack to GitHub.

Before parsing or dispatching a request, it verifies Slack's `X-Slack-Signature` using the exact raw request body and `SLACK_SIGNING_SECRET`. Requests with a missing, invalid, or more-than-five-minute-old timestamp are rejected. The signing secret stays in Vercel and is never forwarded to GitHub Actions.

### `api/slack-request.js`

Contains the authenticated transport handling used by the Vercel function. It preserves the slash-command identity (`/testbot` or `/tasks`) and response URL in the dispatch payload, authenticates slash commands, Events API callbacks, and URL-verification requests, and returns an immediate empty acknowledgement for authenticated slash commands. Python uses the response URL for ephemeral `/tasks` validation responses.

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
4. Passes Slack command, event, and configuration values to `main.py`
5. Runs the Python bot

### `main.py`

Contains the bot logic and routes the owned `/tasks` command family before the Gemini conversation path.

For `/tasks` requests it:

1. Accepts `/tasks list` case-insensitively, allowing surrounding whitespace
2. Returns usage guidance for missing, unknown, or extra arguments
3. Refuses requests outside the configured Tasks channel before accessing Notion
4. Reads at most one task from the configured Notion Tasks data source
5. Creates a public `/tasks list` root message and replies with the linked task name

Every `/tasks` outcome ends before Gemini is invoked. `/testbot` and Slack thread messages retain the existing Gemini-backed conversation behavior.

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

## Slack configuration

Create a Slack App and configure these slash commands:

```text
/testbot
/tasks
```

The Request URL should point to the deployed Vercel function:

```text
https://<your-vercel-project>.vercel.app/api/slack
```

### Required Bot Token Scopes

The app currently uses:

```text
commands
chat:write
channels:history
```

`commands` allows the `/testbot` slash command.

`chat:write` allows the bot to create messages and replies.

`channels:history` allows the bot to retrieve messages from public channels and their threads.

The bot must also be invited to the Slack channel where it is being used.

For example:

```text
/invite @GitHub Test Bot
```

## Slack Event Subscriptions

Enable Event Subscriptions in the Slack App.

Use the same Vercel endpoint:

```text
https://<your-vercel-project>.vercel.app/api/slack
```

Subscribe to the bot event:

```text
message.channels
```

This allows replies inside Slack threads to trigger the bot.

The Vercel function ignores messages generated by the bot itself to prevent an infinite loop:

```text
Bot response
→ Slack event
→ GitHub Action
→ Bot response
→ Slack event
→ ...
```

It also ignores ordinary top-level channel messages.

New conversations must currently be started explicitly using `/testbot`.

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

Slack Bot User OAuth Token.

It normally starts with:

```text
xoxb-
```

### `NOTION_API_KEY`

API key for read-only access to the configured Notion Tasks data source.

### `NOTION_TASKS_DATA_SOURCE_ID`

The ID of the Notion Tasks data source queried by `/tasks list`.

### `TASKS_SLACK_CHANNEL_ID`

The Slack channel ID authorized to use `/tasks`.

Never commit any token, API key, or data-source identifier to the repository.

## GitHub Action environment

The workflow passes information from the `repository_dispatch` payload to Python.

Example:

```yaml
env:
  SLACK_COMMAND: ${{ github.event.client_payload.command }}
  SLACK_TEXT: ${{ github.event.client_payload.text }}
  SLACK_RESPONSE_URL: ${{ github.event.client_payload.response_url }}
  SLACK_CHANNEL_ID: ${{ github.event.client_payload.channel_id }}
  SLACK_THREAD_TS: ${{ github.event.client_payload.thread_ts }}
  SLACK_EVENT_TYPE: ${{ github.event.client_payload.slack_event_type }}
  SLACK_BOT_TOKEN: ${{ secrets.SLACK_BOT_TOKEN }}
  GEMINI_API_KEY: ${{ secrets.GEMINI_API_KEY }}
  NOTION_API_KEY: ${{ secrets.NOTION_API_KEY }}
  NOTION_TASKS_DATA_SOURCE_ID: ${{ secrets.NOTION_TASKS_DATA_SOURCE_ID }}
  TASKS_SLACK_CHANNEL_ID: ${{ secrets.TASKS_SLACK_CHANNEL_ID }}
```

## Conversation model

The project uses a simple convention:

```text
One Slack thread = one task / conversation
```

`/tasks` is an exception to the Gemini conversation path: it is an owned command family. The currently supported command is `/tasks list`; its result is a public root message with a linked task in a threaded reply. Invalid and unauthorized `/tasks` requests return a deterministic response and do not access Notion or Gemini.

The first user message defines the task.

Later user messages are considered follow-up questions, answers or clarifications.

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

Python retrieves the entire Slack thread before asking Gemini to answer the latest message.

This means the application itself does not currently maintain persistent conversation state.

## Gemini

The project currently uses a Gemini Flash-Lite model to keep development and experimentation inexpensive.

The prompt explains that Gemini is participating in an existing Slack thread and instructs it to:

* treat the first message as the original task
* interpret later messages as follow-ups
* use previous messages as context
* respond to the latest user message
* avoid restarting the conversation
* format responses for Slack rather than standard Markdown

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

### Test Slack slash command

```text
/testbot Hello
```

This should:

```text
Slack
→ Vercel
→ GitHub Action
→ Python
→ Gemini
→ Slack thread
```

### Test conversation context

Reply inside the generated Slack thread:

```text
Can you elaborate?
```

A second GitHub Action should start.

The Python logs can temporarily print the reconstructed thread to verify that the complete conversation is being passed to Gemini.

Do not keep full conversation logging enabled in production.

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

The `/tasks list` path is read-only. It authorizes the Slack channel before constructing a Notion request, requests at most one task, and does not send task-command input or Notion data to Gemini.

## Current limitations

The application currently relies on GitHub Actions for each interaction.

That works well for experimentation, but it introduces latency because every Slack message starts a new Actions runner.

For a production conversational bot, a persistent service or serverless execution environment would likely provide lower latency.

The current design intentionally favors simplicity and visibility over response speed.

## Possible next steps

Potential extensions include richer read-only task-list behavior and, separately, carefully constrained write actions.

```text
Slack threads
    ↓
Authenticated /tasks command
    ↓
Read-only Notion access
    ↓
Formatted task-list results
```

Examples:

```text
"Which tasks are currently blocked?"

"Create a task called 'Fix login timeout'."

"Set the Phoenix project priority to High."
```

For write operations, Gemini should not be allowed to generate arbitrary Notion API requests directly.

A safer approach is for Gemini to return structured actions, for example:

```json
{
  "action": "create_task",
  "parameters": {
    "title": "Fix login timeout",
    "priority": "High"
  }
}
```

Python can then validate the requested action before calling the Notion API.

This keeps Gemini responsible for interpreting natural language while application code remains responsible for authorization and side effects.
