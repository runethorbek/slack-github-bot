# Vercel runtime migration — Plan

Status: **Plan approved 2026-10-15. Implementation not started.**
- Slice 1 ([#36](https://github.com/runethorbek/slack-github-bot/issues/36)) is the only implementation issue approved to proceed.
- Slice 2 ([#38](https://github.com/runethorbek/slack-github-bot/issues/38)) stays blocked until #36 is implemented, its production smoke test is recorded, the tracer is reviewed, and the owner explicitly approves proceeding.
- Decisions are recorded in §8. D5 stays open until Slice 1 observations exist.
Companion documents: [BASELINE.md](BASELINE.md) and [ACCEPTANCE.md](ACCEPTANCE.md). RESULTS.md is written after the experiment.

## 1. Goal and constraints

Run the existing TypeScript application (`src/`) for **interactive** Slack requests
directly inside the existing Vercel Function, instead of dispatching each request
to a GitHub Actions runner. Behavior and security boundaries are preserved. This
is a change of runtime, not a rewrite.

Constraints:

- **No product behavior changes** unless the runtime move forces them. Each forced change is listed in ACCEPTANCE.md §3 and needs approval.
- **`src/` stays the application layer.** Routing order, authorization, Notion, Gemini and Slack orchestration stay in `src/main.ts` and its modules. `api/` gains only transport and runtime-adapter code.
- **Tracer first.** Slice 1 moves only `/tasks`, is deployed to production, and is smoke-tested by a human. Nothing else moves until that is approved.
- **No new infrastructure, persistent state or dependencies.** `@vercel/functions` (`waitUntil`) is already a dependency.
- **GitHub Actions stays for CI**, and stays available for every non-migrated path until Slice 2's removal step.
- **The scheduled attention summary is a separate decision** (§6).

## 2. Findings that shape the plan

Answers to the investigation questions. Facts are cited in BASELINE.md. Assumptions are marked.

| # | Question | Answer |
| --- | --- | --- |
| Q1 | What does GitHub Actions provide beyond starting `main.ts`? | An execution host with a 360-minute cap, the application secret store, log masking, failure visibility (a failed run), a per-event audit trail, and the isolation of application secrets from the ingress (BASELINE §2). |
| Q2 | Which variables come from GitHub? | 9 secrets, plus 15 payload-derived `SLACK_*` fields and `SLACK_RESPONSE_URL` (BASELINE §5). |
| Q3 | Which must move to Vercel? | Slice 1: `NOTION_API_KEY`, `NOTION_TASKS_DATA_SOURCE_ID`, `TASKS_SLACK_CHANNEL_ID`, `AUTHORIZED_SLACK_USER_ID` (`SLACK_BOT_TOKEN` is already there). Slice 2 adds `NOTION_PEOPLE_DATA_SOURCE_ID`, `NOTION_INTERACTIONS_DATA_SOURCE_ID`, `NOTION_TRACKS_DATA_SOURCE_ID` and `GEMINI_API_KEY`. `attention-summary.yml` keeps its own GitHub secrets until §6 decides otherwise. |
| Q4 | What GitHub-specific assumptions are in `src/`? | Very few. `main` takes an environment dictionary and never reads `process.env`. GitHub-specific pieces: (a) `runProcess` sets `process.exitCode` and a process-wide `uncaughtException` listener, so the adapter must use `runEntryPoint` instead; (b) the payload → environment mapping lives in the workflow YAML, not in code; (c) comments and the "10-property client_payload limit" bundling of `person`/`task` exist because of `repository_dispatch` (harmless; they keep the same shape); (d) `attention-summary.ts` prints `::error::` workflow annotations (out of scope here). |
| Q5 | Can the entry point be called from Vercel? | Yes. `runEntryPoint(environment, { log })` from `src/main.ts` is the seam. **No change to `src/` is needed for Slice 1.** A small adapter in `api/` builds the environment from the existing dispatch payload exactly as the workflow does. **Open: U1**, whether Vercel's builder can load `src/*.ts` with its `.ts`-extension imports. |
| Q6 | How are acks handled? | Entirely in Vercel, with fixed generic responses, before any application code runs (BASELINE §7). |
| Q7 | Synchronous vs delayed? | All application output is delayed. Only fixed acks and `views.open` are synchronous. The runtime move keeps this split: application work runs inside `waitUntil` after the ack. |
| Q8 | Notion reads/writes, Gemini, thread history? | BASELINE §4 table, columns per path. Writes: P2 (Interaction) and P3 (Task) only. Thread history: P8/P9 only. |
| Q9 | What could be long-running? | Notion retries that honor an unbounded `Retry-After`; sequential Track GETs; Gemini calls without a request timeout (up to 4 SDK attempts); `/people suggest` (several reads + 2 Gemini calls); Interaction save (reads + write + Gemini). |
| Q10 | What changes for timeouts and failures? | The cap drops from 360 min (GitHub job) to the function's `maxDuration`: 300 s by default, 300 s max on Hobby, 800 s on Pro. `waitUntil` work shares that limit and is **cancelled** when it is reached, with no stderr line from `runEntryPoint`. Fluid compute may run concurrent invocations in one instance. That is safe because `src/` has no module state, but it is the reason `runProcess` must not be used. Failure visibility moves from the GitHub run status to Vercel function logs. |
| Q11 | How should post-ack errors reach Slack? | **Today they don't.** The user sees the ack and then nothing; only the GitHub run shows the failure. **Preserve that in both slices** (no new Slack text). Log the same single secret-free line to Vercel logs. This is accepted only as preserved behavior (D4). How failures should become visible is deferred to [#39](https://github.com/runethorbek/slack-github-bot/issues/39). |
| Q12 | What should remain in GitHub Actions? | `ci.yml` (unchanged), `attention-summary.yml` (pending §6), and `slack-message.yml` **only until** Slice 2's removal step. |
| Q13 | Is the attention summary part of this migration? | No. It has no Slack ingress, gets no latency benefit, and works today. A move would need a new publicly reachable cron endpoint. **Decided: it stays in GitHub Actions** (§6, #37). |

## 3. Target architecture

```text
Slack ─▶ Vercel api/slack.js → api/slack-request.js        (unchanged: signature, parsing, fixed acks, views.open)
            │ builds the same dispatch payload as today
            ├─ migrated shape ─▶ waitUntil(runDirect(payload))
            │                        api/: payload → environment (mirrors slack-message.yml)
            │                              + application secrets from process.env (explicit allowlist)
            │                        dynamic import("../src/main.ts") → runEntryPoint(environment, { log })
            │                        src/: routing, authorization, Notion / Gemini / Slack   (unchanged)
            └─ other shapes ───▶ waitUntil(triggerGitHub(payload))  → slack-message.yml   (until Slice 2)
```

Design rules:

1. **The dispatch payload is the contract.** `api/slack-request.js` keeps building exactly the payload it builds today. The cutover point is the single place that today calls `triggerGitHub(payload)`. Migrated shapes call the direct runner with the same payload instead. Vercel routes on fields that are already in the payload (`command`, `slack_event_type`). It never parses command text and never decides authorization.
2. **One mapping, mirroring the workflow.** The adapter builds `main`'s environment from the payload the way `slack-message.yml`'s `env:` block and masking step do: every mapped field present, missing becomes `""`, and `SLACK_RESPONSE_URL` only when `response_url` is a non-empty string. Application secrets come from an **explicit allowlist** of `process.env` names, the same names the workflow passes. `SLACK_SIGNING_SECRET`, `GITHUB_TOKEN` and anything else in Vercel's environment never reach `main`. A test proves the mapping equals the workflow's, reusing the approach of `tests/cross-layer-contract.test.ts`.
3. **Run after the ack, inside `waitUntil`.** The response Slack sees is unchanged. Application code never runs before the HTTP response.
4. **Lazy-load the application.** `src/main.ts` and `@google/genai` are imported dynamically inside the deferred work, so cold-start time for the synchronous paths does not grow. This matters most for `views.open`, whose `trigger_id` expires after 3 s.
5. **Use `runEntryPoint`, never `runProcess`.** No process-global listeners and no `process.exitCode` in a shared, long-lived instance. A non-zero result or a thrown error is logged as `runEntryPoint`'s one secret-free line. The adapter itself logs only constant text.
6. **A provable path marker, without private data.** The adapter logs one constant line per direct execution (for example `Direct runtime: executing <shape>`, where `<shape>` is a fixed label such as `/tasks`) and one constant completion line with the exit code. `main` already logs constant lines such as `Task command handled`. No payload, environment, Slack text, Notion data or URL is ever logged.
7. **No change to `src/` unless strictly required.** If Slice 1 shows that `src/` must change (for example for U1), stop and report before changing it.

## 4. Slices

| # | Slice | Scope | Depends on | Human checkpoint |
| --- | --- | --- | --- | --- |
| **S1** | **Production tracer: `/tasks` runs directly in Vercel** ([#36](https://github.com/runethorbek/slack-github-bot/issues/36)) | Adapter (rules 1–6); route `command === "/tasks"` to it, everything else unchanged; Vercel env vars for `/tasks`; Node 24 for the Vercel project; AGENTS.md + README wording for the new boundary; tests. Workflows untouched. | D1–D3 (approved) | **Required**: production smoke test, then STOP |
| **S2** | **Migrate the remaining interactive paths** ([#38](https://github.com/runethorbek/slack-github-bot/issues/38)) | Route P1–P3 and P5–P9 to the direct runner; remaining Vercel env vars; a `maxDuration` decision (D5); smoke matrix. Then, in a **separate PR**, after the matrix passes and a soak period: remove `triggerGitHub`, `repository_dispatch` and `slack-message.yml`, remove `GITHUB_*` from Vercel, and update docs and tests. | S1 approved | **Required**: smoke matrix before removal; approval before removal |
| **C** | **Scheduled attention summary** ([#37](https://github.com/runethorbek/slack-github-bot/issues/37)) | Decided: it stays in GitHub Actions. No work. | – | done |

### Why these sizes

- **S1 is one command family, but it proves the whole chain.** It covers U1 (module loading on Vercel), environment and secrets on Vercel, the `waitUntil` lifecycle, authorization inside Vercel, Notion reads, both Slack outputs (`chat.postMessage` and `response_url`), logging, and latency. `/tasks` is read-only, Gemini-free and has no thread semantics, so a failure has no lasting effect.
- **S1 routes the whole `/tasks` family, not only `list` (D1).** Routing on the text `list` would need Python-compatible `casefold`/`strip` parsing in `api/`, which is domain logic in the transport layer. Routing the family keeps `main`'s routing order intact: authorization → usage → list. It also exercises the unauthorized-refusal path in production.
- **S2 is one issue with internal checkpoints, not several.** After S1 the remaining work is the same routing change applied to more shapes. The risks that differ (writes, Gemini duration, thread reads) are covered by the smoke matrix and by the order within the slice (read-only → Gemini → writes). Removal of the GitHub path is a **separate PR inside S2**, so rollback stays trivial until every flow is verified.
- **Challenge to the brief:** "removal only after all interactive flows are verified" is kept. A short soak (at least several days of normal use, D6) before removal is added, because Vercel's limits only show up under real conditions, for example an occasional slow Gemini response.

### Rollback

- **S1/S2 cutover:** Vercel Instant Rollback to the previous production deployment, or `git revert` of the routing change. The GitHub path stays fully functional until the removal PR, so rollback restores the old behavior completely.
- **After removal:** reverting the removal PR restores the workflow. `GITHUB_TOKEN` must still exist in Vercel, so remove that secret last (after the soak).

## 5. Risks

| Risk | Impact | Mitigation |
| --- | --- | --- |
| **U1: Vercel cannot load `src/*.ts`** (TS compiled by Vercel; `.ts`-extension imports; `import.meta.main` handling) | Direct path fails at import | Validated first in S1 on a deployment. The adapter catches an import failure and logs one constant line. If it fails: **stop and report**, since a build step or a change to `src/` imports is a design decision. |
| Function cancelled at `maxDuration` | No reply at all and no error line (today: eventually some result) | `/tasks` worst cases are far below 300 s unless Notion sends a long `Retry-After`. In S2, Gemini without a timeout is the main exposure (D5). Documented as a permitted difference only if approved. |
| Failure visibility loss | Failed requests no longer show as failed GitHub runs | Constant start/end log lines plus `runEntryPoint`'s line in Vercel logs. Operator and/or user visibility is deferred to [#39](https://github.com/runethorbek/slack-github-bot/issues/39) (D4). |
| Wider secret surface in Vercel | Vercel now holds the Notion read/write key and the Gemini key next to the signing secret | Add them to the **Production** environment only, not Preview/Development, so preview deployments cannot touch production Notion. The allowlist keeps `GITHUB_TOKEN`/the signing secret out of `main`. Recorded as an accepted change of boundary (ACCEPTANCE §3). |
| Duplicate execution | Duplicate Slack messages or Notion writes | The ack stays immediate and unchanged, so Slack's retry behavior is unchanged. The existing retry guards stay. The runtime adds no retry of its own: `waitUntil` runs once. Event retries (P1/P9) are not guarded today, so they are preserved, not fixed. |
| Cold start delays the ack | Slack 3 s timeout, expired `trigger_id` | Lazy import (rule 4); smoke test checks modal opening still works. |
| Concurrent invocations in one instance | Cross-request leakage | `src/` has no module state; `runEntryPoint` only; each call gets its own environment object and `http` client. |
| Preview deployments behind Vercel Authentication | Cannot test before production | Accepted: the tracer is read-only and instantly reversible. The production smoke test is the validation. |

## 6. Scheduled attention summary (decided)

**Decision (owner, 2026-10-15, [#37](https://github.com/runethorbek/slack-github-bot/issues/37)): keep it in GitHub Actions for now.** It is not part of this migration. Rationale:

- It has no Slack ingress, so the latency argument does not apply.
- It works today, and its failure surfaces visibly as a failed run with `::error::`.
- Vercel Cron would need a **new publicly reachable endpoint** protected by `CRON_SECRET`. That is new attack surface and new code in `api/`. On Hobby, cron runs at most once a day with ±59 min precision. `0 6 * * 1,4` fits, but the timing shifts.
- The real risk of staying is GitHub disabling schedules after 60 days without repository activity. That risk is shared with today's setup and is cheap to watch.
- Revisit if GitHub Actions is otherwise removed, or if the 60-day disabling happens in practice.

## 7. Agentic workflow

Per slice, the same loop as the TS migration, scaled down:

| Role | Who | Responsibilities |
| --- | --- | --- |
| Orchestrator | main session | Writes the slice brief from the issue, owns git, runs `npm run typecheck` and `npm test` itself, passes the **actual** results and the diff to the Reviewer, triages findings |
| Implementer | `slice-implementer` (fresh context, one per slice) | Implements exactly the issue; no dependency changes; no workflow changes in S1 |
| Reviewer | `slice-reviewer` (fresh context, read-only) | Reviews the diff against the issue and ACCEPTANCE.md |
| Human | owner | Approves decisions, sets Vercel env vars and Node version, merges (which deploys), runs the smoke test, approves the next slice |

- At most 3 implement→review cycles per slice; more triggers a stop and report.
- Implementer self-reports are not evidence. Claims about runtime behavior need a test or a deployed observation.
- **No slice starts before the previous one's human checkpoint is recorded** in the issue.
- GitHub writes (PR creation, comments) follow AGENTS.md: they are done only when explicitly requested.

## 8. Decisions

Recorded by the owner on 2026-10-15.

| ID | Decision | Status |
| --- | --- | --- |
| D1 | Slice 1 routes the whole `/tasks` command family (list, usage, unauthorized refusal), not only `list`. Command parsing stays in the application layer, not in `api/`. | **Approved.** |
| D2 | Vercel Production holds the application secrets that migrated paths need (Production environment only), and Vercel executes `src/` authorization in-process. The explicit secret allowlist is kept: unrelated Vercel variables never reach `main`. AGENTS.md's Architecture section is updated: Vercel becomes the execution host; `api/` still makes no authorization decisions and contains no domain logic. | **Approved.** |
| D3 | The adapter lives in `api/` (JS, like `slack-request.js`), imports `src/main.ts` dynamically, and calls `runEntryPoint`. `src/` stays the application layer; no domain logic moves into the Vercel entrypoint. If U1 forces a change to `src/` or a build step, stop and decide then. | **Approved.** |
| D4 | Post-ack failures stay invisible to the Slack user, as today, during Slice 1 and Slice 2. | **Accepted only as preserved current behavior for this migration.** This is deferred operability work, not the desired long-term design. How failures become visible to the operator and/or the user is decided in [#39](https://github.com/runethorbek/slack-github-bot/issues/39). No alerting and no new Slack failure messages are part of this migration. |
| D5 | Function `maxDuration`: keep the default 300 s, or raise it (Pro only, ≤ 800 s). Whether to bound Gemini with a request timeout is a behavior change, so it would be separate. | **Open.** Slice 1 keeps the default; no speculative increase. Decide from the production tracer's observations and later Gemini-path observations. |
| D6 | (S2) Soak period between full cutover and removal of `slack-message.yml`. | Proposed: at least 7 days of normal use with no direct-path failures in the Vercel logs. Confirm in S2. |
| D7 | Attention summary stays in GitHub Actions. | **Decided** in [#37](https://github.com/runethorbek/slack-github-bot/issues/37) (§6). |

## 9. Unknowns

| ID | Unknown | Resolved in | How |
| --- | --- | --- | --- |
| U1 | Can Vercel's Node builder load `src/*.ts` (with `.ts`-extension imports, ESM, `import.meta.main`) from `api/slack.js`? | S1, first | Deployed observation. Stop on failure. |
| U2 | The Vercel project's Node version and plan (Hobby or Pro) | S1, before deploy | Human checks the project settings; Node 24.x is required for parity with GitHub |
| U3 | Real end-to-end latency, old vs new | S1 smoke test | Observed by the human (no instrumentation of private data) |
| U4 | Vercel function duration for `/tasks` in practice | S1 smoke test | Vercel invocation logs |
| U5 | Whether failed `repository_dispatch` runs currently notify the owner | optional | Owner's GitHub notification settings; affects how much visibility is lost |
