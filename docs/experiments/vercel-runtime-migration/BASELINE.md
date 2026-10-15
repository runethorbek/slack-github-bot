# Vercel runtime migration — Baseline

This is a snapshot of the current interactive runtime that the migration must
preserve. Everything here was read from the repository, from GitHub (read-only
`gh`) or from Vercel's public documentation. Anything not verified that way is
marked **assumption**.

- Baseline commit: `4a4ee8c` (`main`, clean working tree)
- Recorded: 2026-10-15
- Preceding experiment: [typescript-migration](../typescript-migration/RESULTS.md). The TypeScript application went live at `407eb03`.

## 1. Current request path

```text
Slack ──HTTPS──▶ Vercel  api/slack.js → api/slack-request.js
                   │  verify X-Slack-Signature (raw body, 5-min window)
                   │  build a dispatch payload (≤ 10 properties)
                   │  return the ack (see §6); waitUntil(triggerGitHub(payload))
                   ▼
          GitHub REST  POST /repos/{owner}/{repo}/dispatches  (event_type slack_message)
                   ▼
          .github/workflows/slack-message.yml  (ubuntu-latest, fresh runner per event)
                   │  checkout → setup-node 24 → npm ci --omit=dev
                   │  mask payload text fields; export SLACK_RESPONSE_URL via $GITHUB_ENV
                   │  env: mapping payload fields + secrets → environment variables
                   ▼
          node src/main.ts → runProcess(process.env) → main(environment)
                   ▼
          Slack Web API / response_url, Notion API, Gemini
```

Facts about the seam between the two layers:

- `main(environment, deps)` in `src/main.ts` is already a pure function of an environment dictionary plus injectable collaborators (`http`, `sleep`, `today`, `log`, `createGeminiClient`). It resolves to an exit code. It does not read `process.env` itself.
- `runEntryPoint(environment, deps)` wraps `main` with the secret-free top-level error handler: one line on stderr, result `1`. `runProcess` adds two process-global effects, a `process.on("uncaughtException")` listener and `process.exitCode`. Both are only right for a one-shot process.
- `src/` has no module-level mutable state. The only process-global effects are the two in `runProcess` (`src/entry-point.ts:88-94`).
- `src/main.ts` ends with a module-level `await runIfEntryPoint(import.meta, …)`. It only runs `main` when the module is the program, so importing the module is side-effect free on Node ≥ 24.2.
- `tests/cross-layer-contract.test.ts` already turns a captured dispatch payload into `main`'s environment exactly as `slack-message.yml` does. It reads the `env:` mapping from the workflow file, uses `""` for any missing field or secret, and adds `SLACK_RESPONSE_URL` only when `response_url` is a non-empty string.

## 2. Workflows

| Workflow | Trigger | Runs | Secrets |
| --- | --- | --- | --- |
| `slack-message.yml` | `repository_dispatch: [slack_message]` | `node src/main.ts` | 9 application secrets (§5) |
| `attention-summary.yml` | cron `0 6 * * 1,4` + `workflow_dispatch` | `node src/attention-summary.ts` | 6 (§5) |
| `ci.yml` | `pull_request`, `workflow_dispatch` | `npm ci`, `npm run typecheck`, `npm test`, a production-install import check of both entry points | none; `permissions: contents: read` |

GitHub Actions provides more than "start `src/main.ts`" (investigation Q1):

1. **Execution host.** A fresh, isolated Node 24 process per event, with a default job timeout of 360 min.
2. **Secret store and injection.** Application secrets live only in GitHub. Vercel never sees Notion or Gemini keys.
3. **Log redaction.** `secrets.*` are masked automatically. Payload text fields and the response URL are masked explicitly by the masking step (security invariant S8 of the TS migration).
4. **Failure visibility.** An uncaught error makes the run fail (red X in the Actions tab). GitHub's default notifications may email the actor on a failed run (**assumption**: not verified for runs started by `repository_dispatch` with this token).
5. **An audit trail.** One run per Slack event, with timing and logs, kept per the repository's retention.
6. **Isolation between the ingress and the application.** The signing secret stays in Vercel. The application secrets stay in GitHub. A compromise of one does not give the other.
7. **Concurrency.** Every event gets its own runner. There is no `concurrency:` group, so events run in parallel and independently.

## 3. CI and test commands

```bash
npm ci
npm run typecheck   # tsc, strict, noEmit, over src/ tests/ scripts/ (not api/)
npm test            # node --test: tests/*.test.ts, tests/slack-request.test.js, equivalence goldens
```

- Test files: 14 `*.test.ts`, 1 `*.test.js` (the Vercel layer), plus `tests/equivalence/` (61 scenarios with frozen goldens). TS migration RESULTS.md §4 recorded 1011/1011 passing at `bb368eb`. The count was not re-run for this document.
- `api/` is JavaScript and is **not** typechecked. Its behavior is covered by `tests/slack-request.test.js` and `tests/cross-layer-contract.test.ts`.
- `main` has **no branch protection**, so CI does not gate merges (TS migration RESULTS.md §8).

## 4. Interactive request shapes and routing (exact list)

Requests handled **entirely in Vercel today**, with no dispatch and no application code:

| Shape | Vercel behavior |
| --- | --- |
| `url_verification` | echoes `challenge` |
| Bot message, or top-level channel message | empty 200 |
| `block_actions`, `people_add_interaction` | `views.open` (awaited before the ack; skipped for Slack retries) |
| `block_actions`, `add_followup_task` / `add_suggested_followup_task` | `views.open` (same) |
| `block_actions`, any other action | empty 200 |
| `view_submission` that is a retry, has bad metadata, or has an unknown `callback_id` | 200 / `{}` |

Requests **dispatched to GitHub Actions**, in `main`'s routing order:

| # | Shape → `main` branch | Authorization (in `src/`) | Notion read | Notion write | Gemini | Slack thread read | Slack output |
| --- | --- | --- | --- | --- | --- | --- | --- |
| P1 | `message` event, `channel_type: im` (root or reply) → DM tracer | exact user-ID match, else silent | – | – | – | – | fixed `DM conversation received.` in thread |
| P2 | `view_submission` `add_interaction_modal` | channel or authorized DM, else silent | Interactions schema, Tracks | **create Interaction** (retries 429/5xx/timeout: TD1) | follow-up Task suggestion (only when Notes are present and the Tasks source is configured) | – | confirmation + follow-up buttons |
| P3 | `view_submission` `add_followup_task_modal` | same | Tasks schema, Tracks | **create Task** (retries 429 only) | – | – | confirmation / "may not have been added" |
| P4 | slash `/tasks` (any text) | channel or authorized DM; unauthorized DM silent, channel gets ephemeral refusal | Tasks query (≤ 5 pages), Track pages | – | – | – | root `/tasks list` + threaded list, or ephemeral usage |
| P5 | slash `/people due` | same | People query, Interactions query | – | – | – | root + threaded list with Suggest buttons |
| P6 | slash `/people suggest <name>` | same | People, Interactions, Track pages, Interactions schema | – | 2 calls (recap/next step, draft) | – | reply with recap, draft, Add-interaction button |
| P7 | `block_actions` `people_suggest` (Suggest button) → dispatched as P6 | same as P6 | as P6 | – | as P6 | – | as P6, plus Vercel's fixed ephemeral ack |
| P8 | any other slash command (in practice `/testbot`) → Gemini conversation | **none** (open to anyone who can run the command) | – | – | 1 call | `conversations.replies` | `💬 text` root + reply |
| P9 | `message` event in a channel thread → Gemini conversation | **none** | – | – | 1 call, unless the thread is rooted at `/tasks list` | `conversations.replies` | reply in thread |

`/people` with other text gets ephemeral usage (part of P5/P6 routing).

## 5. Environment and secrets ownership

| Variable | Vercel today | GitHub `slack-message.yml` | GitHub `attention-summary.yml` | Needed by |
| --- | --- | --- | --- | --- |
| `SLACK_SIGNING_SECRET` | ✔ | – | – | ingress |
| `GITHUB_OWNER`, `GITHUB_REPO`, `GITHUB_TOKEN` | ✔ | – | – | dispatch only |
| `SLACK_BOT_TOKEN` | ✔ (only for `views.open`) | ✔ | ✔ | all |
| `AUTHORIZED_SLACK_USER_ID` | – | ✔ | ✔ | P1–P7, summary |
| `TASKS_SLACK_CHANNEL_ID` | – | ✔ | – | P2–P7 |
| `NOTION_API_KEY` (read **and write**) | – | ✔ | ✔ | P2–P7, summary |
| `NOTION_TASKS_DATA_SOURCE_ID` | – | ✔ | ✔ | P2, P3, P4, summary |
| `NOTION_TRACKS_DATA_SOURCE_ID` | – | ✔ | – | P2, P3, P6 (Track selectors and validation). Not P4: `/tasks list` reads Track pages by id with `NOTION_API_KEY` only |
| `NOTION_PEOPLE_DATA_SOURCE_ID` | – | ✔ | ✔ | P5–P7, summary |
| `NOTION_INTERACTIONS_DATA_SOURCE_ID` | – | ✔ | ✔ | P2, P5–P7, summary |
| `GEMINI_API_KEY` | – | ✔ | – | P2, P6–P9 |

Per-request fields come from the dispatch payload: `SLACK_COMMAND`, `SLACK_TEXT`, `SLACK_CHANNEL_ID`, `SLACK_USER_ID`, `SLACK_EVENT_TS`, `SLACK_THREAD_TS`, `SLACK_CHANNEL_TYPE`, `SLACK_EVENT_TYPE`, `SLACK_PERSON`, `SLACK_INTERACTION_*`, `SLACK_VIEW_CALLBACK_ID`, `SLACK_TASK`, and `SLACK_RESPONSE_URL`. `GOOGLE_API_KEY` is read by `src/gemini.ts` but is not passed by the workflow.

GitHub secret values cannot be read back. Copying them to Vercel needs the original values, which only the owner has.

## 6. Authorization boundary

- **Authenticity:** Slack signature in `api/slack-request.js` (`hasValidSlackSignature`: HMAC-SHA256 over the exact raw body, constant-time compare, ±5-minute window; fails closed without a secret).
- **Authorization:** only in `src/`: `isAuthorizedSlackUser` (P1) and `isPrivateDataRequestAuthorized` (P2–P7). It always runs before any Notion or Gemini call (TS migration invariant S2). Vercel makes no authorization decision (AGENTS.md).
- P8/P9 (`/testbot`, thread replies) are not authorized beyond the Slack signature. That is current behavior.

## 7. Slack acknowledgement behavior (investigation Q6, Q7)

Every response Slack sees within 3 s comes from Vercel, before any application code runs:

| Shape | HTTP response | Extra |
| --- | --- | --- |
| Slash command | `{"response_type":"ephemeral","text":"Working on it…"}` | – |
| Suggest click | empty 200 | fixed ephemeral to `response_url` in `waitUntil` (not on retries) |
| Add-interaction / Task button | empty 200 after `views.open` is awaited | – |
| Modal submission | `{"response_action":"update","view":SAVING_VIEW}` | retries are acknowledged without dispatch |
| Message event | empty 200 | – |

**All application output is delayed** (posted later by `main`). Nothing in `src/` is synchronous with respect to Slack's HTTP request. The dispatch itself runs in `waitUntil` after the response is built.

## 8. Write paths

| Target | Path | Idempotency |
| --- | --- | --- |
| Notion `POST /v1/pages` (Interaction) | P2 | **Not idempotent.** Retries 5xx/timeouts, so it can duplicate (TECH-DEBT TD1) |
| Notion `POST /v1/pages` (Task) | P3 | retries only 429; ambiguous failure → "may not have been added" |
| Slack `chat.postMessage` | all dispatched paths | not idempotent; no retry |
| Slack `response_url` (ephemeral) | P4–P7 usage/refusal | – |
| Slack `views.open` | Vercel only | retry-guarded |

Duplicate protection today: Vercel drops Slack-retried modal submissions (`x-slack-retry-num`). It does **not** drop retried message events (P1, P9) or slash commands. Slack does not retry slash commands; it retries events only when the ack is late.

## 9. Failure and error behavior

- **Uncaught error in `main`:** one secret-free stderr line, exit 1, the GitHub run fails. **The Slack user sees only the ack, then nothing.** There is no error message to Slack.
- **Handled failures** post fixed text: the Tasks failure message in the thread, the Gemini transient-failure reply, "Unable to add the interaction right now", the Task "may not have been added", and so on (pinned by the equivalence goldens).
- **Notion credential failure:** on read commands it escapes, so the run fails. On write paths it degrades (TD7).
- **Dispatch failure (GitHub API non-2xx or network):** logged in Vercel (`GitHub error: <status> <response body>`). The user sees the ack and nothing else.
- **Vercel handler exception:** 500 with `Internal error: <message>` (existing behavior; out of scope).

## 10. Long-running operations (investigation Q9)

Every HTTP call has a 10 s timeout, **except Gemini**, which has no request timeout (`src/gemini.ts:20`).

| Operation | Bound |
| --- | --- |
| Notion retries (`callNotionWithRetries`) | 3 attempts; delay `1 + n` s, **or `Retry-After` honored without an upper bound** (`retryDelay`, `src/tasks-list.ts:642`) |
| `/tasks list` scan | ≤ 5 query pages + one GET per distinct Track of ≤ 20 displayed tasks, all sequential. Worst case without Retry-After ≈ (5 + T) × 3 × 10 s + sleeps |
| `/people due` | 2 paginated scans of ≤ 500 rows each |
| `/people suggest` | several Notion reads + 2 Gemini calls (SDK: 4 attempts, backoff ≤ 8 s, no timeout) |
| Interaction save | Notion reads + write + optional Gemini call |
| Conversation | thread read + 1 Gemini call |

On GitHub the effective cap is the 360-minute job timeout, so none of these is cut off in practice.

## 11. Scheduled workload

`attention-summary.yml` sends one private DM to `AUTHORIZED_SLACK_USER_ID` on Monday and Thursday at 06:00 UTC. It is read-only against Notion, uses no Gemini and has no Slack ingress. A failure surfaces as a failed run with an `::error::` annotation. GitHub may delay it, and disables schedules after 60 days without repository activity. It is independent of `repository_dispatch` and of Vercel.

## 12. Latency (observed, not user-perceived)

Measured from GitHub run metadata (`gh run list` / `gh run view`, 1-second resolution) on 2026-10-15:

- **TS era (`407eb03`), 11 Slack Message runs on 2026-10-14/15:** run created → run completed: 11, 13, 14, 14, 16, 17, 18, 18, 18, 19, 34 s (median 17 s). Which command each run served is not visible: the payload is masked.
- **Two sampled runs, step breakdown:** job start 2–3 s after run creation; set up job + checkout + setup-node + `npm ci` ≈ 5 s; `Run bot` 0–4 s.
- **Python era** (#27/#28): median job 15–19 s plus 2–4 s dispatch-to-start, so roughly 17–23 s from click to final reply.

**Not measured:** Slack → Vercel → dispatch time, and the actual time from a user's command to the first Slack-visible application output. The data above suggests the application work itself is a few seconds of a ~15–20 s total, and the rest is runner overhead. That is an inference, not a measurement.

## 13. Vercel platform facts relevant to the move (from vercel.com docs, read 2026-10-15)

- `waitUntil` promises "have the same timeout as the function itself. If the function times out, the promises will be cancelled."
- Fluid compute (default) duration: default 300 s on all plans; maximum 300 s on Hobby, 800 s on Pro/Enterprise.
- Fluid compute may run several invocations concurrently in one instance.
- Vercel's Node runtime **compiles** TypeScript using the root `tsconfig.json`. Its documentation describes TS files *inside `api/`*. It does not document how it handles `.ts` files imported from outside `api/` with explicit `.ts` extensions (`allowImportingTsExtensions`). **Unknown, see PLAN.md U1.**
- Node 24 LTS is available for functions. The project's configured Node version is **not known** from the repository: there is no `engines` field and no `vercel.json`.
- Vercel Cron: Hobby allows at most once per day, with ±59 min precision. Pro allows per-minute schedules.
- The Vercel plan (Hobby or Pro) of this project is **not known** from the repository.
