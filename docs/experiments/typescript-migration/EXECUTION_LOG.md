# TypeScript migration — Execution log

This log is written by the Orchestrator as each slice happens. Timestamps are
local (+02:00) and taken from the shell clock. "Human interventions" counts
messages from the user that changed or unblocked the work. Routine tool-permission
approvals are not counted, because the Orchestrator cannot observe them.

## Phase 1 — Baseline and planning

- Ended: 2026-10-13 12:09. The start time was not captured.
- Outcome: PLAN.md, BASELINE.md and ACCEPTANCE.md written, with no application code changed.
- Baseline: 358 Python tests and 96 JS tests, all passing.
- Human interventions: 1. The approval came with modifications: D5 reversed (add PR CI), an execution log, a technical-debt doc, a Vercel preview check, and autonomous progression through the slices.

## Phase 2 — Slices

Phase 2 started 2026-10-13 12:20, on branch `experiment/typescript-migration`.

### S0 — Toolchain, CI and foundations

- Started 12:21. The Orchestrator installed the approved pinned dependencies (D1/D4): `@google/genai@2.29.0`, `typescript@7.0.2`, `@types/node@24.19.2`. npm 11 blocked protobufjs install scripts (transitive dependency of `@google/genai`); nothing needed them.
- The Orchestrator also added `node_modules/` to `.gitignore`. It was missing because nothing had been installed in the repo before.
- U1 (`@google/genai` Interactions API) resolved early by reading the SDK types: `ai.interactions.create`, `output_text`, `ApiError.status`, `GEMINI_API_KEY` env. **Resolved positively.**
- U4 resolved: Python 3.12.10 installed locally (`py install 3.12`). The baseline holds on 3.12 (358 OK). The goldens are generated with 3.12.
- **Implementation attempt 1** (Implementer, ~16.5 min): DONE. 43 new tests; 139/139 JS/TS; typecheck clean; 358 Python OK; golden `--check` OK.
  - Beyond the brief, the Implementer exhaustively compared casefold and isspace over all code points, fuzzed the date, HTTP-date and float parsers against Python, and found and fixed two secret-leak paths on its own: the response body was visible via `util.inspect` on an `HTTPError`, and the error from `new Headers()` quoted the header value.
  - Self-reported gaps: casefold for code points newer than Unicode 15; `pyJsonDumps` writes whole-number floats as ints; JS lists integer-like object keys first; `json()` rejects NaN/Infinity.
- The Orchestrator re-ran all checks independently, and the results matched the report. Fact check: `setup-node` latest is v7.1.0, while the Implementer had assumed v6.
- **Review 1** (~5 min): PASS, 0 blocking, 2 should-fix, 3 nit.
  - R1 (should-fix): body-read failure was classified as ConnectionError, while requests raises ChunkedEncodingError, which is not retryable. The difference could cause an extra Interaction create.
  - R2 (should-fix): timeouts were named `Timeout`, while requests names them `ReadTimeout`/`ConnectTimeout`. That name appears in a log line.
  - R3 (nit): setup-node@v6 should be @v7.
  - R4 (nit): golden "raises" rows accepted any error type.
  - R5 (nit): `skipLibCheck` was not self-reported.
  - Q: Unicode-version digit gap.
- Orchestrator decision: fix R1–R4 now, because later slices depend on them. Record R5 only.
- **Implementation attempt 2** (~1.2 min): fixed R1–R4. 140/140 tests.
- **Review 2** (~45 s): PASS. R1–R4 resolved. New finding R6 (should-fix): a timeout during the body read was named `ReadTimeout`, but requests raises `ConnectionError`. The Reviewer cited the requests source from memory. **The Orchestrator verified the claim in the installed source (`requests/models.py:942-943`), and it was correct.**
- **Implementation attempt 3** (~36 s): fixed R6.
- Not re-reviewed by the Reviewer. The change was 2 lines plus a test, and the Orchestrator verified it by reading the code and re-running all checks. This is a deviation from the full loop, recorded here.
- **Outcome: ACCEPTED** at 12:55.
  - Totals: 3 implementation attempts, 2 review rounds. Findings: 0 blocking, 3 should-fix (R1, R2, R6), 3 nit (R3, R4, R5). R1–R4 and R6 resolved autonomously; R5 recorded only.
  - 0 human interventions.
  - Final checks: typecheck clean; 140/140 JS/TS; 358 Python OK (3.12); golden check OK; `api/` unchanged.
- Open: whether CI runs in GitHub, and the Vercel effect (U3). Both are checked after the push.
- 12:57: branch pushed; draft PR #34 opened. These GitHub writes are within the brief's PR deliverable and the approved preview check.
- **CI (`ci.yml`) first run on GitHub: pass** (26 s; typecheck, npm test, Python 3.12 unittest, golden `--check`).
- **Vercel preview (U3): the build and deployment succeeded** with the committed lockfile and root `tsconfig.json`. A runtime probe could not be completed: the preview is protected by Vercel Authentication (HTTP 302 to the login page), and no Vercel CLI or credentials are available. Recorded as "build validated, runtime not validated". No attempt was made to bypass the protection.

### S1 — Golden recorder and scenarios

- Started 12:57.
- **Implementation attempt 1** (~11 min): DONE. 50 scenarios, 50 goldens, recorder with `--check`, CI step.
  - Self-reported baseline surprises: google-genai for py 3.12 is **2.30.0** (BASELINE lists 2.20.0, the 3.14 install), and its Interactions errors are `_gaos.lib.compat_errors` classes with `.status_code`; a thread reply under a `/tasks list` root exits 0 silently; Interaction create also retries a ReadTimeout (this widens TD1).
  - No canary leaked in the Python baseline.
- The Orchestrator re-ran the checks (`--check` OK, 358 OK, 140/140), and they matched the report.
- **Review 1** (~5.6 min): PASS, 0 blocking, 3 should-fix, 2 nit, 2 questions.
  - The Reviewer independently verified the SDK claim in the installed source and hand-checked 10 goldens against the Python source, all correct.
  - R1 (should-fix): invariant clauses without a scenario: empty authorized user, Task create timeout, Task missing Person, unconfigured Tracks, 401 on best-effort paths.
  - R2 (should-fix): main.py error branches without a scenario: conversation Gemini 401, Slack HTTP 401, response_url failure, missing env.
  - R3 (should-fix): the canary check covered the uncaught message but not the full traceback chain.
  - R4 (nit): kwargs recorded by reference. R5 (nit): Retry-After numeric rule not enforced.
  - Questions: the private SDK import path, and normalisation rules for the replay.
- Orchestrator decision: fix everything. Rationale: the goldens become the frozen reference after Python is removed, so any gap left now is permanent. Q1: record the SDK version and warn on mismatch. Q2: document the replay normalisation rules now.
- **Implementation attempt 2** (~3.3 min): fixed R1–R5, Q1 and Q2; 12 new scenarios (62 total).
  - New baseline observation: a 401 on Interaction create is caught, gives a generic message and exits 0. Recorded as TECH-DEBT TD7, and BASELINE S11 was corrected. TD8 records the unpinned genai SDK and its private error module.
- **Review 2** (~1.5 min): PASS. R1–R5 resolved; all 12 new goldens checked against the source.
  - R6 (should-fix): the README's uncaught-message replay rule was stricter than ACCEPTANCE §1, because it would force TS to reproduce Python's `str(KeyError)`.
  - R7 (nit): a non-string Retry-After gives a TypeError instead of a RecorderError.
- R6 resolved by an **Orchestrator spec decision**, edited directly into `tests/equivalence/README.md`: the message is required only when it is application-defined. R7 recorded and not fixed (cosmetic; the recorder still fails).
- **Outcome: ACCEPTED** at 13:22.
  - Totals: 2 implementation attempts, 2 review rounds. Findings: 0 blocking, 6 should-fix (R1, R2, R3, R6 + Q1/Q2 handled as requests), 3 nit (R4, R5, R7).
  - Resolved autonomously: R1–R5 by the Implementer, R6 by the Orchestrator. R7 deferred.
  - 0 human interventions.
