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

### S2 — slack-authorization + tasks-list

- Started 13:23.
- **Implementation attempt 1** (~11.8 min): DONE.
  - Added 5 + 23 ported tests and 7 TS-only tests; 186/186 pass.
  - The mechanical mapping check (Python `def test_` names vs TS title prefixes) finds 23/23 and 5/5 mapped.
  - The Implementer also extended the S0 file `python-compat.ts` with `KeyError`, `withPyCause` and `getPyCause` (a cause chain hidden from `util.inspect`, for S7).
  - It ran manual mutation checks: 5 mutations each failed tests.
- The Orchestrator re-ran the checks (typecheck 0, 186/186, 358 OK, golden check OK, mapping OK) and grepped for forbidden JS idioms (none found). Everything matched the report.
- **Review 1 interrupted**: the Reviewer stopped after ~2 min / 21 tool calls with "session limit reached" (HTTP 429, the account usage limit) and delivered no report.
- **Human intervention #2**: the user asked to continue after the limit reset. This is an environment interruption, not a decision about the work.
- **Review 1 resumed** after the limit reset (~2 min more): verdict BLOCKED.
  - The Reviewer found no code defect: a line-by-line equivalence check, all 28 tests compared assertion by assertion, and the security invariants all came out clean.
  - R1 (blocking): the slice criterion required tests for invariant S2 (authorization before calls). That ordering lives in main.py (S8). **This was an Orchestrator planning defect, not an implementation defect.**
  - R2 (nit): sleepSeconds hangs instead of raising OverflowError on an absurd Retry-After.
  - R3 (nit): JS String() vs Python str() for schema-violating values.
  - R4 (nit): a mapping note overstated an assertion.
  - R5 (nit): the JSON accessors are private, and S3–S6 need them.
- Orchestrator resolution, with no code change:
  - R1: amended the PLAN S2/S8 rows, added a §9 amendment and a G6 "deferred to S8" row.
  - R4: reworded the mapping note.
  - R2 and R5: scheduled for the S3 brief.
  - R3: accepted as a documented difference.
- **Review 2** (~1 min): PASS. R1 and R4 resolved. R6 (nit): the amendment had a placeholder timestamp; the Orchestrator fixed it.
- **Outcome: ACCEPTED** at 15:20.
  - Totals: 1 implementation attempt, 2 review rounds (the first was interrupted and resumed). Findings: 1 blocking (a planning defect), 0 should-fix, 5 nit.
  - Resolved autonomously: R1, R4, R6 (all by the Orchestrator). R2 and R5 deferred to S3; R3 accepted.
  - 1 human intervention (the post-limit "continue").

### S3 — people-due

- Started 15:22. The brief included two carry-overs from the S2 review: R5 (move the JSON accessors into python-compat) and R2 (the sleep overflow).
- Orchestrator design decision before implementation: Python lazily imports people_suggest, which isn't ported until S5. S3 ports the branch as a dynamic import, with a typed placeholder `people-suggest.ts` that throws until S5, and defers the 2 suggest-path tests to S5 (recorded in TEST-MAPPING).
- **Implementation attempt 1** (~16.8 min): DONE.
  - 54/56 tests ported; the 2 deferred tests are the only ones missing. 8 TS-only tests; 279/279 overall.
  - 11 deliberate mutations, each caught. The Implementer identified and replaced 2 equivalent mutations.
  - It determined the CPython 3.12 `time.sleep` thresholds by experiment.
  - Its own test run hung under mock timers once (a leftover background process); it fixed the test.
- The Orchestrator re-ran the checks (typecheck 0, 279/279, 358 OK, golden check OK, mapping 54/56 with exactly the 2 deferred tests missing) and grepped for forbidden idioms (none found).
- **Review 1** (~3.5 min): **PASS**, 0 blocking, 0 should-fix, 1 nit (R1: a documented cast).
  - The Reviewer compared ~25 tests assertion by assertion and checked the R2 logic against pytime.c. It could not run Python to confirm the boundaries.
  - **The Orchestrator confirmed all four boundary values with py -3.12**, including that 9223372036.854774 is accepted (still sleeping after a 3 s timeout).
- **Outcome: ACCEPTED** at 15:42.
  - Totals: 1 implementation attempt, 1 review round. Findings: 0 blocking, 0 should-fix, 1 nit (accepted as documented).
  - S2 carry-overs R2 and R5 resolved.
  - 0 human interventions.

### S4 — people-interaction (first Notion write path)

- Started 15:47.
- **Implementation attempt 1** (~10.8 min): DONE.
  - 39/39 tests ported plus 24 TS-only tests (including TD1, TD3 and TD7 pins); 357/357 overall.
  - All 5 required mutations caught.
  - Button values compared byte for byte against py -3.12.
  - **Tooling hazard reported by the Implementer**: its file-writing tool turned `\uXXXX` escapes into literal characters, even inside `String.raw`. It repaired the affected expected strings with a script.
- The Orchestrator re-ran the checks (typecheck 0, 357/357, 358 OK, golden check OK, mapping 39/39). It also **scanned every src/ and tests/ .ts file for control, format or invisible characters (none)** to rule out silent corruption in earlier slices.
- **Review 1** (~2.8 min): **PASS**, 0 blocking, 0 should-fix, 1 nit.
  - The Reviewer did a security walk-through: no path reaches the create without validation; S3, S4, S7 and S11 hold; TD1, TD3 and TD7 are pinned by tests that would fail if the TD were fixed. 14 tests were compared assertion by assertion.
  - It checked the escape hazard: clean, with literal escape sequences in the expected values and the real U+2013 en dash.
  - R1 (nit): **the Implementer's report overstated its own test** ("6 cases incl. ß and tab"; the test has 5 cases, neither ß nor tab). The Orchestrator confirmed the literal escapes on disk.
  - **Recorded as an Implementer reporting inaccuracy.** No behavior risk: `pyJsonDumps` is covered by the S0 golden table.
- **Outcome: ACCEPTED** at 15:57.
  - Totals: 1 implementation attempt, 1 review round. Findings: 0 blocking, 0 should-fix, 1 nit (accepted; claim corrected here).
  - 0 human interventions.

### S5 — people-suggest (largest slice; Gemini model-output boundary)

- Started 15:58. The slice was not split; the Implementer completed it in one run.
- **Implementation attempt 1** (~31.3 min, the longest run so far): DONE.
  - 110/110 tests ported, plus 22 TS-only tests. The 2 people_due tests deferred from S3 now pass; the S3 placeholder test was rewritten to the real route. 552/552 overall.
  - New `pySplitlines` with golden rows. The marker regex was translated with Python `re` semantics and verified by an exhaustive code-point probe against Python-generated sets.
  - New Python-generated prompt fixture with `--check`; prompts byte-identical.
  - 11 mutations, each caught.
  - Reported 6 discrepancies between `docs/people-suggest-gemini-context.md` and the code, unfixed as instructed.
  - **Tooling hazard recurred**: `\uXXXX` was turned into literal characters in 3 places, even via bash heredocs; repaired at the byte level.
- The Orchestrator re-ran everything: typecheck 0, 552/552 (~6 s), 358 OK, all 3 generators `--check` OK, mapping OK.
  - **Gap found by the Orchestrator: CI did not run the new prompt generator's `--check`.**
- **Review 1** (~4.6 min): **PASS**, 0 blocking, 1 should-fix, 0 nit.
  - The Reviewer independently confirmed the AI boundary (S5), the exact context (S6), the code-point bounds (S10), the credential handling (S11), regex fidelity, and over 25 tests assertion by assertion.
  - R1 (should-fix): CI is missing the prompt fixture check. This is the same as the Orchestrator's observation.
  - It independently found 4 of the doc-drift items; the Implementer's list was not visible to it.
  - It could not re-run the mutations.
- Orchestrator actions:
  - R1 fixed by the Orchestrator (one CI step added).
  - **Spot-checked one mutation itself**: `MAX_NEXT_STEP_SUGGESTIONS` 2→3 makes 13 tests fail; file restored, 0 fail.
  - The doc drift is recorded as TECH-DEBT TD9 (doc corrected in S9). The truncated-scan "not found" is recorded as TD10.
- **Outcome: ACCEPTED** at 16:35.
  - Totals: 1 implementation attempt, 1 review round. Findings: 0 blocking, 1 should-fix (fixed by the Orchestrator), 0 nit.
  - 0 human interventions.

### S6 — followup-task (second Notion write path; second Gemini boundary)

- Started 16:40 (2026-10-13).
- **Implementation attempt 1 interrupted**: the Implementer stopped with "session limit reached" (HTTP 429, the account usage limit) while writing the TEST-MAPPING section. Its last message: "Now I'll write the mapping section and update the G6/TD tables."
- **Human intervention #3**: the user asked to continue after the limit reset (2026-10-14). This is an environment interruption.
- **Implementation attempt 1, resumed** (~2 min after the resume; ~25 min of work before the interruption): DONE.
  - 53/53 tests ported plus 29 TS-only tests; 707/707 overall.
  - New `pyJsonLoads`: a port of the CPython 3.12 JSON scanner, iterative so deep input can't exhaust the JS stack, plus ~140 golden rows. New Python-generated follow-up fixture with `--check`, added to CI by the Implementer.
  - 11 mutations, each caught.
  - Unverified assumption: `PY_JSON_MAX_DEPTH = 9997` on Linux, derived from the CPython headers; only Windows was measured (2997).
- The Orchestrator re-ran everything: typecheck 0, 707/707, 358 OK, all 4 generator `--check` runs OK, mapping OK.
  - The Orchestrator tried to verify the Linux depth limit via Docker, but Docker Desktop and WSL were stopped. **It decided not to start applications on the user's machine** for an edge case (JSON nested about 10,000 levels deep), and recorded the limit as an unverified assumption.
- **Review 1** (~7.5 min): **PASS**, 0 blocking, 0 should-fix, 1 nit.
  - The Reviewer reviewed `pyJsonLoads` as a parser port, confirmed S3, S4, S5, S7, S9, S10 and S11, and checked that the `truthy(NaN)` change is safe across ~45 callers.
  - R1 (nit): the Python generators contain raw invisible characters instead of escapes. Accepted: the generators are removed with Python in S9.
  - Questions: the depth assumption (to go in RESULTS.md), and the RecursionError raised after the write (recorded as TECH-DEBT **TD11**).
- **The Orchestrator spot-checked the key S9 mutation** (Task create also retries a 5xx): 6 tests fail; file restored, 0 fail.
- **Outcome: ACCEPTED** at 09:11 (2026-10-14).
  - Totals: 1 implementation attempt (interrupted and resumed), 1 review round. Findings: 0 blocking, 0 should-fix, 1 nit (accepted).
  - 1 human intervention (the post-limit "continue").

### S7 — attention-summary entry point, golden replay harness, first workflow cutover

- Started 09:21 (2026-10-14).
- **Implementation attempt 1** (~18.7 min): DONE.
  - 36/36 tests ported plus 10 TS-only tests (4 run the real process).
  - New generic replay harness: one child process per scenario, network blocked, strict script; 28 permanent self-tests showing it is not lenient.
  - All 6 attention goldens match. `attention-summary.yml` cut over to Node.
  - The local dry run matches Python exactly. 802/802 overall. Module mutations M1–M4 and harness mutations H1–H5 were all caught.
- **Side effect outside the repo, reported by the Implementer**: an `env -i py -3.12` call during the dry run made the Python install manager download Python into the scratchpad (since deleted) and print "Python install manager was successfully updated to 26.4".
  - The Orchestrator checked: `py list` still shows 3.14.2 (default) and 3.12.10, and both work.
  - Whether the install manager itself was updated could not be determined. **This is surfaced to the user.**
- The Orchestrator re-ran everything: typecheck 0, 802/802, 358 OK, generator checks OK, mapping OK, goldens untouched, dry run exit 1 with Python's exact line, and the workflow diff limited to the runtime steps.
- **Review 1** (~4.3 min): **PASS**, 0 blocking, 3 should-fix, 1 nit.
  - The Reviewer confirmed line-by-line equivalence, harness strictness, the safety of the S7 allowlist across all error classes, and an import graph with no dev dependencies.
  - R1 (should-fix): the fake http accepts `params` on POST, `json` on GET, and `json: null`, which is more permissive than the real adapter.
  - R2 (should-fix): no test pins the content of `attention-summary.yml` (G7 evidence).
  - R3 (should-fix): on Node < 24.2, `import.meta.main` is undefined, so the scheduled run would silently do nothing and exit 0.
  - R4 (nit): `String()` vs Python `str()` for non-string Slack error codes. Accepted as a documented assumption.
- Orchestrator decision: fix R1–R3. R1 matters because S8 relies on the harness; R3 removes a silent-failure mode in production.
- **Implementation attempt 2** (~4 min): R1–R3 fixed.
  - The fake http is now per-method strict, rejects `json: null`, and has 5 new self-tests.
  - A G7 workflow content test was added; 5 workflow mutations were each caught.
  - New `entryPointMode` makes the entry point fail loudly on Node < 24.2.
  - 810/810.
- The Orchestrator re-ran everything: typecheck 0, 810/810, 358 OK, golden check OK, goldens untouched.
- **Review 2** (~1 min): **PASS**, R1–R3 resolved, no new findings.
  - The Reviewer reasoned that `entryPointMode` cannot misfire on the runner: on Node >= 24.2, `import.meta.main` short-circuits before any path comparison.
- **Outcome: ACCEPTED** at 09:42.
  - Totals: 2 implementation attempts, 2 review rounds. Findings: 0 blocking, 3 should-fix (all fixed autonomously), 1 nit (accepted assumption).
  - 0 human interventions.
  - Also recorded: 1 unintended side effect outside the repo (the py install manager), surfaced to the user.
  - Still open: U2, the real ubuntu-latest execution of the cutover workflow (post-merge smoke test).
