# Vercel runtime migration — Acceptance criteria

These are the invariants for the migration and the criteria for each slice. The
reference for "existing behavior" is `main` at `4a4ee8c` ([BASELINE.md](BASELINE.md)).
The TypeScript migration's security invariants S1–S11 ([../typescript-migration/ACCEPTANCE.md](../typescript-migration/ACCEPTANCE.md) §3)
keep applying. S8 (workflow masking) applies to every path that still runs in
GitHub Actions. V7 below replaces it for direct paths.

## 1. Invariants (every slice)

| ID | Invariant | Evidence |
| --- | --- | --- |
| V1 | **Slack signature verification is unchanged** and runs before any parsing, routing or application code. A request that fails verification never reaches the direct runner. | existing `slack-request.test.js` signature tests pass unmodified; a new test shows an invalid signature on a `/tasks` request runs nothing |
| V2 | **Same acknowledgements.** The HTTP response (status and body) for every request shape is byte-identical to the baseline, as are the Suggest `response_url` ack and `views.open`. | existing ack tests pass unmodified |
| V3 | **Same authorization.** Authorization happens only in `src/` (`isAuthorizedSlackUser`, `isPrivateDataRequestAuthorized`), in the same order, before any Notion or Gemini call. `api/` makes no authorization decision. An unauthorized request in a migrated path makes no Notion or Gemini call. | entry-point routing tests + a direct-path test with a fake `http` that records zero Notion calls for an unauthorized channel and DM |
| V4 | **Same application input.** For each migrated shape, the environment passed to `main` equals what `slack-message.yml` would produce for the same request, except for application secrets that are not in the allowlist (none are expected). | contract test that derives the expected environment from the workflow file, as `cross-layer-contract.test.ts` does |
| V5 | **Same Slack-visible output and Notion semantics.** Same messages, blocks, threads, ephemeral responses, Notion reads and writes (count, order, payloads, retry policy). | `src/` unchanged (diff), equivalence goldens pass, smoke test |
| V6 | **Same Gemini boundaries.** Same prompts, same paths call Gemini, model output never triggers a side effect. | `src/` unchanged, goldens |
| V7 | **No private data in logs.** The adapter logs only constant strings (plus an exit code). It never logs the payload, the environment, Slack text, Notion data, prompts, model output, response URLs or tokens. Errors are reported only through `runEntryPoint`'s secret-free line or a constant adapter line. | test that captures `console`/stdout/stderr on success, application failure and import failure; review; production log inspection |
| V8 | **Secret allowlist.** `main` receives only the application secret names the workflow passes. `SLACK_SIGNING_SECRET`, `GITHUB_*` and any other Vercel variable are never in its environment. | adapter test with extra variables in `process.env` |
| V9 | **No duplicate execution introduced.** Each accepted request runs the application at most once: no new retry, no double dispatch (direct **and** GitHub) for any shape. The existing retry guards are unchanged. | test per migrated shape: direct runner called once, `triggerGitHub` not called; retry-guard tests unchanged |
| V10 | **Application logic stays in `src/`.** `api/` changes are limited to routing on existing payload fields, the payload → environment mapping, invoking `runEntryPoint`, and constant logging. `api/` contains no command-text parsing, no Notion/Gemini calls and no authorization. | diff review |
| V11 | **Process hygiene.** The direct path uses `runEntryPoint`, not `runProcess`: no `process.on` listeners, no `process.exitCode`, and no `process.env` mutation. | test + review |
| V12 | **Lazy loading.** Synchronous paths (acks, `views.open`, URL verification) do not import `src/main.ts` or `@google/genai`. | test or review of the import graph |
| V13 | **CI unchanged and independent.** `ci.yml` keeps working without secrets; `npm run typecheck` and `npm test` pass. The production-install import check covers `api/slack.js` as well. | CI run |
| V14 | **No GitHub Action for migrated requests.** A migrated request causes no `repository_dispatch` and no `slack-message.yml` run. Non-migrated requests still do (until removal). | tests + production smoke test (Actions tab) |
| V15 | **Production smoke test is required for every cutover.** A slice is not complete on passing tests alone. | checklist recorded in the issue by the human |
| V16 | **No new dependencies, infrastructure or persistent state.** Changes to `package.json`/`package-lock.json` need approval. Adding `engines.node` or Vercel project settings for Node 24 is allowed. | diff |

## 2. Permitted differences

These are expected, and recorded in RESULTS.md:

- **Execution host and limits.** The application runs in a Vercel Function. Its time limit is the function's `maxDuration`, not the GitHub job timeout. Work still running at the limit is cancelled without a Slack reply. Any observed occurrence is reported; it informs the open D5 and #39.
- **Where logs go.** `main`'s constant log lines and `runEntryPoint`'s error line go to Vercel function logs instead of the GitHub run log. A failure no longer marks a GitHub run as failed.
- **Latency.** User-perceived latency is expected to drop. It is not a behavior contract.
- **Secret location.** Application secrets exist in Vercel (Production environment), as approved in PLAN.md D2.

## 3. Changes that are *not* permitted without explicit approval

- Any new Slack-visible text, including a generic error reply, and any alerting (PLAN D4; deferred to #39).
- Any change to `src/` behavior, prompts, retry policy or timeouts (for example a Gemini timeout, PLAN D5).
- A change to the function's `maxDuration` in Slice 1 (PLAN D5 is open until Slice 1 observations exist).
- Fixing preserved tech debt (TD1 duplicate Interaction, TD7, unguarded event retries) as part of the move.
- Moving the attention summary (#37).

## 4. Slice acceptance

**Slice 1 (`/tasks` tracer)** is accepted when:

1. V1–V16 hold for the `/tasks` shape. Every other shape is provably unchanged: it still dispatches to GitHub with the same payload, and existing tests pass unmodified.
2. `npm run typecheck` and `npm test` pass locally and in CI.
3. A fresh-context review reports no unresolved blocking finding.
4. The production smoke test in #36 is completed by the human and recorded in the issue.
5. Work then **stops** until the human approves Slice 2.

**Slice 2 (remaining paths)** is accepted when:

1. V1–V16 hold for every interactive shape (P1–P9 in BASELINE §4).
2. The full smoke matrix in #38 passes in production.
3. Removal happens in a separate PR, only after step 2 and the soak period (PLAN D6): no `triggerGitHub`, no `GITHUB_*` usage in `api/`, `slack-message.yml` deleted. Tests asserting on that workflow are retired or rewritten, each with a reason recorded. Docs (README, AGENTS.md) describe the new runtime.
4. `ci.yml` and `attention-summary.yml` (which stays in GitHub Actions per #37) still run.
