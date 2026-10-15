# Slack → GitHub Actions → Gemini Bot

A Slack bot that uses:

* Slack as the user interface
* Vercel as a lightweight webhook endpoint
* GitHub Actions as the runtime/orchestration layer
* TypeScript on Node.js for the bot logic
* Notion as the source of Tasks, Tracks, People, and Interactions data. The bot reads it, and creates Interactions and Tasks after validating what the user submitted in a Slack modal
* Google Gemini for open-ended conversation, for drafting suggested messages, and for suggesting follow-up Tasks
* Slack threads as conversation context

The goal of the project is to explore a simple event-driven AI integration without running a permanent backend service.

## Architecture

```text
Slack
  │
  │ /testbot <message>  │  /tasks list  │  /people due | suggest <person>  │  button click / modal submission
  ▼
Vercel Function
/api/slack
  │
  ├── /tasks (whole command family): runEntryPoint from src/main.ts, in the Vercel Function
  │
  │ everything else: repository_dispatch
  ▼
GitHub Actions
  │
  ▼
node src/main.ts
  │
  ├── /testbot, thread replies → Gemini conversation
  │
  ├── /tasks list            → Notion Tasks + Tracks lookup (read-only)
  │
  ├── /people due | suggest  → Notion People + Interactions lookup (read-only)
  │                              (suggest drafts text via Gemini)
  │
  └── modal submissions      → validated Notion write: one Interaction or one Task
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

The Node.js process is stateless. Instead of storing conversation state itself, it retrieves the Slack thread and uses it as the conversation history.

`/tasks` and `/people` are owned, deterministic command families that never reach the Gemini conversation path (`/people suggest` is the one exception that calls Gemini, and only to draft text — see [Gemini](#gemini)).

## Runtime

The application runs on **Node.js 24** (24.2 or later). Node runs the `.ts` files directly with its native type stripping, so there is no build step and no compiled output: the workflows run `node src/main.ts` and `node src/attention-summary.ts`. The code therefore uses only erasable TypeScript syntax (`erasableSyntaxOnly` in `tsconfig.json`).

Type checking is separate: `npm run typecheck` runs `tsc` in `strict` mode with `noEmit`, over `src/`, `tests/` and `scripts/`.

Dependencies are pinned in `package-lock.json` and installed with `npm ci`. The runtime dependencies are `@google/genai` (the Gemini SDK) and `@vercel/functions` (used by `api/`).

The application was migrated from Python. Its behavior was kept identical, including the quirks of the original implementation, and is pinned by golden files recorded from the Python version (see [Equivalence goldens](#equivalence-goldens)). This is why `src/python-compat.ts` and `src/plain-date.ts` exist, and why many comments cite the original Python names.

## Repository structure

```text
.
├── api/
│   ├── slack.js
│   ├── slack-request.js
│   └── _direct-runtime.js
├── .github/
│   └── workflows/
│       ├── attention-summary.yml
│       ├── ci.yml
│       └── slack-message.yml
├── src/
│   ├── main.ts
│   ├── attention-summary.ts
│   ├── entry-point.ts
│   ├── tasks-list.ts
│   ├── people-due.ts
│   ├── people-suggest.ts
│   ├── people-interaction.ts
│   ├── followup-task.ts
│   ├── gemini.ts
│   ├── http.ts
│   ├── slack-authorization.ts
│   ├── python-compat.ts
│   └── plain-date.ts
├── scripts/
│   ├── fetch-notion-schema.ts
│   └── preview-people-suggest-prompts.ts
├── tests/
│   ├── *.test.ts
│   ├── slack-request.test.js
│   └── equivalence/
├── docs/
│   ├── notion-interactions-schema.md
│   ├── notion-people-schema.md
│   ├── notion-tasks-schema.md
│   ├── notion-tracks-schema.md
│   ├── people-suggest-gemini-context.md
│   ├── ubiquitous-language.md
│   ├── experiments/
│   │   └── typescript-migration/
│   └── specs/
│       ├── tasks-list.md
│       └── track-resolution.md
├── package.json
├── package-lock.json
├── tsconfig.json
└── README.md
```

### `api/slack.js`

Vercel Function responsible for receiving requests from Slack. It delegates request handling to `api/slack-request.js` and triggers a GitHub `repository_dispatch` event with the parsed payload, except for `/tasks` (see `api/_direct-runtime.js`). It also opens the "Add interaction" and "Add follow-up task" modals (Slack `views.open`) when their buttons are clicked.

The Vercel function deliberately contains very little application logic. Its primary responsibility is transporting events from Slack to the application.

### `api/_direct-runtime.js`

Runs the application directly in the Vercel Function for the `/tasks` command family (list, usage and the unauthorized refusal), with no `repository_dispatch` and no GitHub Actions run. This is slice 1 of the [Vercel runtime migration](docs/experiments/vercel-runtime-migration/PLAN.md); every other request shape still goes through GitHub Actions. The leading underscore keeps Vercel from exposing the module as its own `/api` route.

After the acknowledgement, inside `waitUntil`, it builds `main`'s environment from the same dispatch payload exactly as `slack-message.yml` does, takes only the workflow's nine application secrets from Vercel's environment (an explicit allowlist, so `SLACK_SIGNING_SECRET` and `GITHUB_*` never reach `main`), lazily imports `src/main` and calls `runEntryPoint`. Vercel's builder compiles `src/*.ts` and ships them as `.js`, so a deployment loads `src/main.js`; locally only `src/main.ts` exists, and the adapter falls back to it only when `src/main.js` itself is missing. Command parsing and authorization stay in `src/`. It logs only constant lines: `Direct runtime: executing /tasks` and `Direct runtime: finished /tasks with exit code <n>`, next to `main`'s own constant lines. As on the GitHub path, a failure after the acknowledgement is not reported in Slack.

### `api/slack-request.js`

Contains the authenticated transport handling used by the Vercel function.

Before parsing or dispatching a request, it verifies Slack's `X-Slack-Signature` using the exact raw request body and `SLACK_SIGNING_SECRET`. Requests with a missing, invalid, or more-than-five-minute-old timestamp are rejected. The signing secret stays in Vercel and is never forwarded to GitHub Actions.

It handles these request shapes:

1. **Slash commands** (`/testbot`, `/tasks`, `/people`) — preserves the command, text, and response URL in the dispatch payload, and immediately returns a fixed ephemeral acknowledgement (`Working on it…`) that is identical for every command and contains no request data. The final reply follows from the GitHub Actions run, or, for `/tasks`, from the direct run in Vercel. The application uses the response URL for ephemeral validation/refusal responses.
2. **Events API callbacks** (message events and URL verification) — forwards thread replies and authorized root DMs; ignores the bot's own messages and ordinary top-level channel messages.
3. **Block Kit interactivity** (button clicks) — a "Suggest message" button attached to a `/people due` result is dispatched as if the user had typed `/people suggest <name>`, reusing the exact same Person-resolution and Gemini-drafting path as the typed command. Vercel also posts a fixed ephemeral acknowledgement (`Working on a suggestion… It will be posted as a new message.`) to the click's `https://hooks.slack.com/` response URL, in the background after the empty 200; it contains no request data, is skipped for Slack retries, leaves the `/people due` list unchanged, and is not replaced when the suggestion follows. The "Add interaction" and "Add follow-up task" buttons open their modal from the options carried in the button's value; no Notion access happens in Vercel.
4. **Modal submissions** (`view_submission`) — the submitted "Add interaction" or "Add follow-up task" fields are dispatched to GitHub Actions, where they are validated and written.

### `slack-message.yml`

GitHub Actions workflow triggered by:

```yaml
repository_dispatch:
  types: [slack_message]
```

The workflow:

1. Checks out the repository
2. Sets up Node.js 24
3. Installs the runtime dependencies (`npm ci --omit=dev`)
4. Masks and exports the Slack response URL separately so it never appears in a workflow `env:` mapping (which GitHub Actions would log), and masks the user-supplied payload fields
5. Passes Slack command, event, and configuration values to the bot
6. Runs the bot: `node src/main.ts`

### `ci.yml`

Runs on every pull request (and manually): `npm ci`, `npm run typecheck` and `npm test`. It has read-only repository permissions, uses no secrets, and is independent of the Slack workflows.

### `src/main.ts`

Entry point and Slack transport glue. It authorizes and routes requests in this order, before any of them can reach the Gemini conversation path:

1. Authorized-DM tracer — a deterministic acknowledgement for any message the one authorized Slack user sends in the bot's DM, including thread replies. A `/testbot` conversation started in the DM therefore cannot be continued there; use a channel.
2. Modal submissions — authorized like `/tasks` and `/people`, then handed to [`src/followup-task.ts`](#srcfollowup-taskts) or [`src/people-interaction.ts`](#srcpeople-interactionts).
3. `/tasks` and `/people` authorization — both command families are restricted to the configured Tasks channel or the authorized user's DM; unauthorized requests are refused without touching Notion.
4. `/people` — delegates to [`src/people-due.ts`](#srcpeople-duets).
5. `/tasks` — delegates to [`src/tasks-list.ts`](#srctasks-listts).

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

An error that escapes is reported by the shared top-level handler in `src/entry-point.ts` as one line on stderr (the error's class name, plus its message only for the application's own error classes, never a stack, a URL or a body), and the run exits with code 1.

### `src/tasks-list.ts`

Implements `/tasks list`, fully deterministic and Gemini-free, plus the Notion helpers the other modules share (headers, retries, Track pages):

1. Accepts `/tasks list` case-insensitively, allowing surrounding whitespace; anything else returns usage guidance.
2. Reads a bounded set (up to 500) of non-finished tasks from the configured Notion Tasks data source, with retry on transient Notion failures.
3. Filters to tasks needing attention (no follow-up date, or a follow-up within 7 days), sorts by follow-up date then priority then name, and caps the displayed list at 20.
4. Resolves each distinct related Track at most once, so a task's Track name and priority can be shown without duplicate Notion lookups.
5. Posts a public `/tasks list` root message and replies with the formatted task list.

Malformed individual task or Track records are skipped rather than failing the whole command; an incomplete scan is reported honestly instead of being presented as an empty or complete result.

### `src/people-due.ts`

Implements `/people due` and routes `/people suggest <person>`, fully deterministic on the Notion-access side:

1. Reads every Person with a configured Contact cadence, and every dated Interaction on or before today, each in one bounded, paginated scan.
2. Groups Interactions by related Person locally, then evaluates each Person's cadence (no previous interaction, not due, due today, or overdue) against calendar-month arithmetic.
3. Sorts due People by next-contact-due date then name, caps the displayed list at 20, and posts a threaded reply as both formatted text and Block Kit sections.
4. Each due Person's block includes a "Suggest message" button (see `api/slack-request.js`) that invokes `/people suggest <name>` on click.

### `src/people-suggest.ts`

Implements `/people suggest <person>`. It resolves the named Person by a case-insensitive Name match (refusing to guess when zero or multiple People match), reads their context fields, up to 5 recent Interactions and their Tracks, and asks Gemini (via an injected `generateText` function) for a private recap and a short reconnect message using only that supplied context. Gemini never accesses Notion directly and never decides who to contact. The exact context sent to Gemini, and its bounds, is documented in [docs/people-suggest-gemini-context.md](docs/people-suggest-gemini-context.md).

The private recap call also returns a "Suggested next step" section with one or two advisory suggestions (issue #23). Each suggestion's kind must be an exact live Interaction Type option or `Wait`; the application drops anything else and keeps at most two. If the Type options could not be loaded, no next step is requested; if the next-step part is missing or has no valid suggestions, the section is simply omitted. Suggestions never trigger a write.

When the live Interaction Type options are available, the reply also carries an "Add interaction" button.

### `src/people-interaction.ts`

The "Add interaction" button and the Interaction write path. The button's value carries the Person's identity and the live Type and Track options, so the modal Vercel opens needs no Notion access. A submitted modal is validated in this order: the date, the Type (against the live Notion schema), the Track (against the live Tracks, only when one was chosen), then the title property; only then is the Interaction page created and linked to the Person. The create uses the default Notion retry policy: a 429, a 5xx, a timeout or a connection error is retried, so a failure that happened after Notion had already created the page can lead to a duplicate Interaction (known tech debt TD1). Gemini is never involved. After a successful write, the confirmation can carry the "Add follow-up task" buttons.

### `src/followup-task.ts`

The "Add follow-up task" buttons and the Task write path. After an Interaction is saved, the confirmation offers a plain "Add follow-up task" button and, when the Interaction has Notes, possibly a second button prefilled from a Gemini suggestion (see [Gemini](#gemini)). A submitted Task modal is validated (name, follow-up date, the live Tasks schema, Priority, Track, and the `Ikke startet` Status) and then the Task page is created. The create is retried only on HTTP 429; a 5xx, a timeout or a connection error, which might have happened after Notion created the page, is not retried and posts "The follow-up task may not have been added. Check Notion before trying again." instead.

### `src/gemini.ts`

The Gemini client (`@google/genai`), the model name, and the conversation helpers used by `src/main.ts`.

### `src/http.ts`

A small `requests`-like adapter over `fetch` (`post`/`get`, `raise_for_status`, `json`, timeouts). Its error messages never contain a URL, headers or a body, and the underlying fetch error is never attached.

### `src/slack-authorization.ts`

Shared authorization check for `/tasks`, `/people` and modal submissions: a request is authorized if it comes from the configured Tasks Slack channel, or from the one authorized user's DM.

### `src/entry-point.ts`

Process concerns shared by the two entry points: the top-level error handler (one secret-free stderr line, exit code 1) and the guard that runs a module only when it is the program.

### `src/python-compat.ts` and `src/plain-date.ts`

Helpers that reproduce the Python 3.12 behaviors the application relies on where JavaScript differs (string handling by code point, `json.dumps`/`json.loads`, `date.fromisoformat`, calendar dates without time zones). They are checked against a table recorded from Python.

### `attention-summary.yml` and `src/attention-summary.ts`

A separate workflow runs Monday and Thursday at 06:00 UTC (`0 6 * * 1,4`) and can also be started manually via `workflow_dispatch`. GitHub may delay scheduled runs, and disables schedules after 60 days without repository activity. It sets up Node.js 24, runs `npm ci --omit=dev`, then `node src/attention-summary.ts`.

`src/attention-summary.ts` sends one private DM to `AUTHORIZED_SLACK_USER_ID` summarizing what needs attention, reusing the exact `/tasks list` eligibility and `/people due` cadence logic so it matches those commands on the same day:

* Tasks with a Follow-up date: at most 5 listed, then `+N more — run /tasks list`.
* Tasks without a Follow-up date: a count only.
* Due People: at most 5 listed as plain text (no Suggest button), then `+N more — run /people due`.

Nothing is sent when nothing needs attention. An incomplete scan counts as something to report, with the same "more may need attention" line the commands use; skipped malformed rows are noted within a shown section but never trigger a DM on their own.

Any failure fails the run with a secret-free `::error::` annotation, so an unwatched scheduled run stays visible. If one source fails, the other section is still sent with an "unavailable" line when it has something to report. If both fail, or the Slack send fails, nothing is sent. Gemini is not used, and only error types, HTTP status codes and missing setting names are logged.

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

Enable **Interactivity & Shortcuts** with the same Request URL so button clicks (the `/people due` "Suggest message" button, "Add interaction" and "Add follow-up task") and modal submissions reach the bot.

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
SLACK_BOT_TOKEN
```

Example:

```text
GITHUB_OWNER=runeivan
GITHUB_REPO=slack-github-bot
```

`GITHUB_TOKEN` must be stored as a secret and must have permission to trigger `repository_dispatch` on the repository.

`SLACK_SIGNING_SECRET` must be stored as a secret and match the signing secret for the Slack app that sends requests to the endpoint.

`SLACK_BOT_TOKEN` must be stored as a secret; `api/slack.js` uses it to open the "Add interaction" and "Add follow-up task" modals, and the direct `/tasks` path passes it to `main`.

The direct `/tasks` path also needs these, in the **Production** environment only, with the same values as the GitHub secrets:

```text
NOTION_API_KEY
NOTION_TASKS_DATA_SOURCE_ID
TASKS_SLACK_CHANNEL_ID
AUTHORIZED_SLACK_USER_ID
```

The project's Node.js version must be 24.x (`engines` in `package.json`).

Do not commit the GitHub token to the repository.

## GitHub Secrets

Configure these repository secrets under:

```text
Settings
→ Secrets and variables
→ Actions
```

### `GEMINI_API_KEY`

API key used by the application to call Google Gemini.

### `SLACK_BOT_TOKEN`

Slack Bot User OAuth Token. It normally starts with:

```text
xoxb-
```

### `NOTION_API_KEY`

API key for the configured Notion data sources. The integration reads all four data sources, and must be able to create pages in the Interactions and Tasks data sources (they are written to, not only read).

### `NOTION_TASKS_DATA_SOURCE_ID`

The ID of the Notion Tasks data source queried by `/tasks list`. Also used by the "Add follow-up task" button on an Interaction confirmation: its schema supplies the Priority options and the `Ikke startet` Status, and a submitted Task modal creates a Task there (`src/followup-task.ts`). If unset, the button is omitted (and no Gemini call is made). When the saved Interaction has Notes, Gemini may also suggest one Task from them; the application validates it and offers a second "Add task: <name>" button that opens the same modal with Name, Description and Follow-up prefilled for review. The modal's optional Description text is written to the `Description` property only if that property exists as a text (`rich_text`) property; otherwise the Task is created without it.

### `NOTION_PEOPLE_DATA_SOURCE_ID`

The ID of the Notion People data source queried by `/people due` and `/people suggest`.

### `NOTION_INTERACTIONS_DATA_SOURCE_ID`

The ID of the Notion Interactions data source queried by `/people due` and `/people suggest`, and where the "Add interaction" modal creates Interactions.

### `NOTION_TRACKS_DATA_SOURCE_ID`

The ID of the Notion Tracks data source. Queried to populate the Track selector in the "Add interaction" and "Add follow-up task" modals and to validate a submitted Track id before it is written to an Interaction or Task. If unset, the Track selector is simply omitted from the modal.

### `TASKS_SLACK_CHANNEL_ID`

The Slack channel ID authorized to use `/tasks` and `/people`.

### `AUTHORIZED_SLACK_USER_ID`

The single Slack member ID authorized to use the private DM tracer and to use `/tasks`/`/people` from a DM. In Slack, open the member's profile, choose *More*, and select *Copy member ID*; use the ID value (typically beginning with `U`), not the display name.

Never commit any token, API key, or data-source identifier to the repository.

## GitHub Action environment

The workflow passes information from the `repository_dispatch` payload to the bot as environment variables.

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

The full mapping in `.github/workflows/slack-message.yml` also passes the modal fields (`SLACK_PERSON`, `SLACK_INTERACTION_TYPE`, `SLACK_INTERACTION_NOTES`, `SLACK_INTERACTION_DATE`, `SLACK_INTERACTION_TRACK_ID`, `SLACK_VIEW_CALLBACK_ID`, `SLACK_TASK`).

The workflow reads the response URL from GitHub's event payload, masks it, and exports it to the bot as `SLACK_RESPONSE_URL` in a separate step. Do not pass it directly through a workflow `env:` mapping, because GitHub Actions logs environment values.

## Conversation model

The project uses a simple convention:

```text
One Slack thread = one task / conversation
```

`/tasks` and `/people` are exceptions to the Gemini conversation path: they are owned command families.

* `/tasks list` — a public root message with a formatted, Track-annotated task list in a threaded reply.
* `/people due` — a threaded reply listing People due for contact, each with a "Suggest message" button.
* `/people suggest <person>` — a threaded reply with a private recap, optional next-step suggestions, a Gemini-drafted reconnect message for that Person, and, when the Notion Interaction Type options can be loaded, an "Add interaction" button.

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

The bot retrieves the entire Slack thread before asking Gemini to answer the latest message. This means the application itself does not currently maintain persistent conversation state.

## Gemini

The project currently uses a Gemini Flash-Lite model to keep development and experimentation inexpensive.

Gemini is used in three, deliberately separated ways:

* **Open-ended conversation** (`/testbot` and thread replies) — the prompt explains that Gemini is participating in an existing Slack thread and instructs it to treat the first message as the original task, interpret later messages as follow-ups, use previous messages as context, respond to the latest user message, avoid restarting the conversation, and format responses for Slack rather than standard Markdown.
* **Follow-up Task suggestion** (after saving an Interaction with Notes) — Gemini sees only that Interaction's Person name, Date, Type and Notes plus today's date, and may return one suggested Task name, description and follow-up date as JSON. `src/followup-task.ts` validates and bounds these fields; they only prefill the Task modal, and nothing is written until the user submits it.
* **Constrained drafting** (`/people suggest <person>`) — Gemini receives only the bounded Person context and recent Interactions that `src/people-suggest.ts` assembles deterministically, and is asked only to draft message text. It never chooses which Person to contact, never accesses Notion, and never performs a side effect; the user reviews and sends the draft themselves.

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
→ Node.js (src/main.ts)
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
npm ci
npm run typecheck
npm test
```

`npm test` runs `node --test`: the TypeScript tests under `tests/`, the Vercel layer's tests (`tests/slack-request.test.js`), and the equivalence goldens. The tests use fakes for Slack, Notion and Gemini and need no secrets. CI (`.github/workflows/ci.yml`) runs the same three commands on every pull request.

### Equivalence goldens

`tests/equivalence/` holds end-to-end scenarios and the observables (HTTP calls, Gemini prompts, retry sleeps, printed lines, exit code) that the original Python implementation produced for them, plus fixtures for Python string, JSON and date semantics, the `/people suggest` prompts and the follow-up Task suggestion. `npm test` replays every scenario against the TypeScript entry points and compares the result.

These files are frozen: the Python recorder and generators were removed with the Python code, so they cannot be regenerated, and a change to them is a change to the specification. See [tests/equivalence/README.md](tests/equivalence/README.md).

### Dev scripts

Two read-only local utilities live in `scripts/`. Both read their configuration from environment variables, never print the API key, and are run with Node directly.

**Inspect the Gemini prompts for `/people suggest`.** Prompts are never logged in GitHub Actions, so to see exactly what context (Person, Interactions, Tracks and their Purposes) reaches Gemini, run a local dry run:

```powershell
$env:NOTION_API_KEY = "..."
$env:NOTION_PEOPLE_DATA_SOURCE_ID = "..."
$env:NOTION_INTERACTIONS_DATA_SOURCE_ID = "..."
node scripts/preview-people-suggest-prompts.ts "<Person name>"
```

It runs the real command against live Notion (read-only) but replaces Gemini and Slack with local stubs, then prints the recap/next-step prompt and the draft-message prompt. The output contains private Notion data; do not paste it anywhere public or commit it.

**Dump the live Notion schemas.** To write or correct the `docs/notion-*-schema.md` files against the real schema:

```powershell
$env:NOTION_API_KEY = "..."
$env:NOTION_PEOPLE_DATA_SOURCE_ID = "..."        # set any of the four
$env:NOTION_INTERACTIONS_DATA_SOURCE_ID = "..."
$env:NOTION_TASKS_DATA_SOURCE_ID = "..."
$env:NOTION_TRACKS_DATA_SOURCE_ID = "..."
node scripts/fetch-notion-schema.ts
```

It writes each configured data source's `properties` (schema only, no row data) to `schema-dump/<name>.json`, which is git-ignored.

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

The only Notion writes are the two modal submissions. Each is authorized the same way before any Notion request, every submitted value is validated by application code (Person identity from the button's structured value; Type, Priority, Status and Track against live Notion data), and each valid submission leads to one page create. The Task create is retried only on HTTP 429 and reports an ambiguous failure as "may not have been added"; the Interaction create is also retried on 5xx, timeout and connection errors, so it can create a duplicate (known tech debt TD1). Gemini's output never causes a write: a suggested follow-up Task only prefills a modal that the user must submit.

## Current limitations

The application currently relies on GitHub Actions for each interaction except `/tasks`, which runs directly in Vercel.

That works well for experimentation, but it introduces latency because every Slack message starts a new Actions runner.

For a production conversational bot, a persistent service or serverless execution environment would likely provide lower latency.

The current design intentionally favors simplicity and visibility over response speed.

## Possible next steps

Potential extensions include richer read-only behavior and, separately, further carefully constrained write actions — for example, allowing Gemini to interpret a request like "Create a task called 'Fix login timeout'" or "Set the Phoenix project priority to High."

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

Application code can then validate the requested action before calling the Notion API, exactly as `/people suggest` and the follow-up Task suggestion already keep Gemini responsible only for interpreting/drafting while application code stays responsible for authorization and side effects.
