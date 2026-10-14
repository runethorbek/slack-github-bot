# TypeScript migration — Results

Final report of the experiment "Autonomous Python-to-TypeScript Migration" on
`runethorbek/slack-github-bot`. Branch `experiment/typescript-migration`, draft
PR #34. Not merged, not deployed.

Companion records: [PLAN.md](PLAN.md), [BASELINE.md](BASELINE.md),
[ACCEPTANCE.md](ACCEPTANCE.md), [EXECUTION_LOG.md](EXECUTION_LOG.md),
[TEST-MAPPING.md](TEST-MAPPING.md), [TECH-DEBT.md](TECH-DEBT.md).

**Reading convention.** Every statement here is either **observed** (a command
was run, a file was read, or an event is recorded in EXECUTION_LOG.md) or
explicitly marked **assumption** / **not verified**. Metrics the Orchestrator
could not observe are reported as unavailable, not estimated.

## 1. Summary

| Question | Answer | Basis |
| --- | --- | --- |
| Technical migration success | **Yes**, subject to the post-merge smoke test (§8). | All application logic runs as TypeScript on Node 24. 1011/1011 tests pass, typecheck is clean, CI passes, no Python remains, and the Vercel layer is unchanged. |
| Functional equivalence | **Yes for everything observable in the frozen Python reference.** Six small edge-case differences were **explicitly accepted by the user** (§5.2). | All 62 Python-recorded end-to-end scenarios replay identically. All 358 Python tests have a TS counterpart. |
| Autonomous completion | **Largely autonomous.** 1 decision intervention (plan approval) and 3 environmental resumes. No human fixed, decided or debugged anything during Phases 2–3. | §3 |
| Quality of the agentic process | **Good but not self-sufficient.** Review caught every blocking problem before commit, but several defects were found only by later slices, by Orchestrator spot checks, or by asking for tests of claims. | §6 |

A technically successful migration is not by itself evidence of successful
autonomous engineering. §6 and §7 assess the process separately from the result.

## 2. Timeline and effort

| Phase | Wall clock (local time) | Notes |
| --- | --- | --- |
| Phase 1: baseline and plan | ended 2026-10-13 12:09 | The start time was not captured. |
| Approval | 12:09 → 12:20 | 1 human intervention, with modifications. |
| Phase 2: S0–S9 | 2026-10-13 12:20 → 2026-10-14 13:08 | Includes 3 pauses caused by account usage limits (§3). |
| Phase 3: validation | 2026-10-14 13:08 → ~13:20 | |
| Phase 4: this report and the PR | 2026-10-14 ~13:20 → | |

- **Total elapsed wall clock** from the start of Phase 2 to the end of Phase 3: about **25 hours**. **Most of it was waiting on usage limits**, including one overnight pause. The pause lengths can only be bounded, not measured: the moment each agent was cut off was not recorded.
- **Measured subagent run time** (sum of the durations the harness reported per subagent call):
  - Implementers: ≥ **153 min**. This excludes the work done before the interruptions in S6 and S8, which was not reported.
  - Reviewers: ≈ **59 min**.
  - Orchestrator time is not included and was not measured.
- **Token usage and cost: not available.** The Orchestrator cannot see account usage. The harness reports a per-call "subagent_tokens" figure, but its meaning (context size vs. cumulative usage) is not documented, so it is not summed into a cost. If you want cost figures, take them from `/cost` or the console.

## 3. Process metrics

### Per slice

| Slice | Scope | Implementation attempts | Review rounds | Blocking | Should-fix | Nit | Accepted |
| --- | --- | ---: | ---: | ---: | ---: | ---: | --- |
| S0 | toolchain, CI, Python-semantics foundations | 3 | 2 ¹ | 0 | 3 | 3 | 10-13 12:55 |
| S1 | Python golden recorder, 62 scenarios | 2 | 2 | 0 | 4 | 3 | 13:22 |
| S2 | slack-authorization, tasks-list | 1 | 2 ² | 1 ³ | 0 | 5 | 15:20 |
| S3 | people-due | 1 | 1 | 0 | 0 | 1 | 15:42 |
| S4 | people-interaction (write path) | 1 | 1 | 0 | 0 | 1 | 15:57 |
| S5 | people-suggest (Gemini boundary) | 1 | 1 | 0 | 1 | 0 | 16:35 |
| S6 | followup-task (write path, Gemini) | 1 ² | 1 | 0 | 0 | 1 | 10-14 09:11 |
| S7 | attention-summary entry point, replay harness, cutover | 2 | 2 | 0 | 3 | 1 | 09:42 |
| S8 | main entry point, Gemini client, Slack cutover | 1 ² | 1 | 0 | 0 | 3 | 12:39 |
| S9 | remove Python, scripts, docs | 2 | 2 | 1 | 1 | 2 | 13:08 |
| **Total** | **10 slices** | **15** | **15** | **2** | **12** | **20** | all accepted |
| Final full-branch review | | | 1 | 0 | 1 | 4 | PASS |

¹ The third S0 fix (2 lines) was verified by the Orchestrator, not re-reviewed. This is a recorded deviation from the loop.
² The run was interrupted by an account usage limit and resumed with its context intact. It is counted as one attempt.
³ An Orchestrator planning defect, not an implementation defect (§6.3).

- **Stop condition (more than 5 cycles per slice):** never reached. The maximum was 3 implementation attempts (S0).
- **Iterations in total:** 15 implementation attempts and 16 review rounds (15 per-slice plus 1 final).

### Defects and their resolution

**Blocking (2): both resolved before commit.**
- S2 R1 was resolved by the Orchestrator amending the plan.
- S9 R1 was resolved by the Implementer: the README had overstated a security property.

**Should-fix (13)**, counting the final review:

| Outcome | Count | Which |
| --- | ---: | --- |
| Resolved autonomously | 11 | 9 by Implementers, 2 by the Orchestrator (S1 R6 spec decision, S5 R1 CI step) |
| Accepted as expected under decision D3 | 1 | S9 R4: CI can no longer re-verify the goldens against Python |
| Accepted by the user (2026-10-14) | 1 | Final R1, the six semantic differences in §5.2 |

**Nits (24):** most were fixed. The rest are recorded as accepted assumptions or follow-ups.

**Defects found outside the reviewer loop**, all resolved:
- **S5's Gemini error handling.** The S5 port worked with Python-shaped fake errors, but a real `@google/genai` 429 would have crashed `/people suggest` instead of posting the transient reply. It was found by the S8 Implementer while testing against the real SDK.
- **A CI gap** in S5: the prompt fixture's `--check` was not wired into CI. Found by the Orchestrator.
- **Two inaccurate Implementer self-reports:**
  - S4: claimed test cases that did not exist.
  - S8: claimed the SDK error leaked the API key in `.cause`. A test written in S9 proved it does not.
- **Two Orchestrator facts corrected by agents:**
  - the setup-node major version;
  - the Python Gemini SDK retry count. BASELINE said 2 retries; it is actually 3 (4 attempts). The S8 Implementer measured this and the S8 Reviewer confirmed it in source.

### Human interventions

There were **5** in total:

| # | When | What | Kind |
| ---: | --- | --- | --- |
| 1 | After Phase 1 | Approval with modifications: add PR CI, an execution log, a tech-debt document, a Vercel preview check, and autonomous slices. | Decision (requested by the brief) |
| 2 | During the S2 review | "can you continue" after an account usage limit. | Environmental resume |
| 3 | During S6 | "can you continue" after an account usage limit. | Environmental resume |
| 4 | During S8 | "can you continue" after an account usage limit. | Environmental resume |
| 5 | After Phase 4 | Accepted the six differences in §5.2. | Decision (requested by ACCEPTANCE §1) |

No human made a technical decision, fixed code, or unblocked a design question
during Phases 2–3.

## 4. Test results (observed, HEAD `bb368eb`)

| Check | Result |
| --- | --- |
| `npm run typecheck` (`tsc`, strict, `noUncheckedIndexedAccess`, erasable-only) | 0 errors (src, tests, scripts) |
| `npm test` (`node --test`) | **1011 tests, 1011 pass**, 0 skipped or todo |
| — of which the 96 original Vercel-layer tests (`tests/slack-request.test.js`) | 96 pass; the file is byte-unchanged from the baseline |
| — of which golden replays | **62/62** Python-recorded scenarios (6 attention summary, 56 main) |
| Test traceability | **358/358** Python tests mapped to TS tests. Mechanical check run before Python was removed. |
| Last Python run before removal (S9) | 358 OK; all 4 generator `--check` runs OK |
| GitHub CI (`ci.yml`) | Passes on every pushed slice, including `bb368eb` |
| CI production-install check (added in Phase 3) | Passes. Locally shown to fail when a dev-only import is planted. |
| Vercel preview build | Passes. Runtime not probed (§8). |
| `git diff d3404ed -- api/` | Empty (G8) |

Equivalence evidence has three independent layers (PLAN §3):
1. **Ported unit tests.** All 358 are ported with the Python test name as the TS test-title prefix.
2. **Golden replay.** 62 end-to-end scenarios were recorded from the unmodified Python. The replay compares HTTP call order, URLs, headers, bodies, timeouts, Gemini prompts, retry sleeps, stdout, exit codes and secret canaries.
3. **Python-generated fixtures.** These cover every Python-semantics helper (casefold, whitespace, code-point lengths, `json.dumps`/`json.loads`, `fromisoformat`, regex classes and more), the `/people suggest` prompts and the follow-up Task parsing.

## 5. Functional differences

### 5.1 Permitted by ACCEPTANCE.md §1 (recorded)

- **Crash output.** An uncaught error prints one secret-free line instead of a Python traceback. This is stricter than before: no URLs, bodies or cause chains are printed.
- **HTTP.** The timeout is one overall 10 s timeout instead of separate connect and read timeouts. Request bodies are serialized with JS spacing; they are semantically equal.
- **Gemini SDK internals.**
  - The SDK is `@google/genai` 2.29.0, while the reference is Python google-genai 2.30.0.
  - Retries are configured to Python's 4 attempts, with exponential backoff (0.5 s base, 8 s cap); the exact jitter timing differs.
  - A non-Interaction 200 response yields `""` where Python would crash.
  - A whitespace-only `GOOGLE_API_KEY` is handled differently.
  - Vertex mode is left to the SDK.
- **Unverified Linux limit.** JSON nesting deeper than about 9,997 levels: the Linux CPython limit is assumed from the headers and was not measured (§8).
- **Dev scripts.** The usage line names `node scripts/….ts` instead of `python scripts/….py`.
- **Slack workflow.** The step "Run Python bot" is renamed "Run bot". The masking step and the `env:` block are byte-identical.

### 5.2 Not on the permitted list: **accepted by the user on 2026-10-14**

ACCEPTANCE §1 says any other difference is a defect unless you accept it. The
final review found these six. None can realistically be triggered by Slack or
Notion as they behave today, and each is documented in code or tests.

| # | Difference | When it could matter |
| --- | --- | --- |
| a | JS objects iterate integer-like keys first. Python keeps insertion order. | A Notion property *named* like an integer (e.g. "2024") when the code scans `properties` by position. |
| b | Response bodies are parsed with `JSON.parse`, which rejects `NaN`/`Infinity`. Python's requests `json()` accepts them. | A Slack or Notion response containing `NaN` (not valid JSON). |
| c | `casefold` uses Node's newer Unicode tables for code points added after Unicode 15. Also, digit recognition in `float` parsing follows Node's Unicode version. | Names using characters added in Unicode 16 or 17. |
| d | `pyJsonDumps` writes whole-number floats as ints (`1` vs `1.0`). | Only if a float reached a Block Kit button value. Today only strings do. |
| e | A non-string Slack `error` code is formatted with JS `String()`, not Python `str()`. | Slack returning a non-string `error` field, which contradicts its API contract. |
| f | A malformed Slack `messages` value (a dict) gives the error name `TypeError` where Python gives `KeyError`. | A malformed `ok: true` response from `conversations.replies`. |

## 6. Assessment of the agentic process

### 6.1 What worked (observed)

- **Independent review caught both blocking problems before commit**:
  - a plan defect in S2;
  - a README that overstated a security guarantee: "exactly one page", where Interaction create can duplicate (TD1).
- **The read-only Reviewer was genuinely independent.** It could not edit or run anything. It verified claims against source; for example, it confirmed the Python SDK retry count by reading the SDK. It also refused to accept untestable claims.
- **Python-generated references.** Recording behavior from the real Python (goldens and fixtures) gave review an objective target instead of opinions about equivalence.
- **The harness was itself tested.** Its strictness was proven by self-tests, so no slice could weaken the replay comparison without being noticed.
- **Mutation testing** by Implementers, with Orchestrator spot checks in S5 and S6, showed that the security-relevant tests actually detect regressions.
- **The plan structure held.** No slice needed more than 3 attempts, the ordering (foundations → leaves → entry points → retirement) produced no rework, and the S5 split contingency was never needed.

### 6.2 What did not work, or worked only partly (observed)

- **Per-slice review cannot see cross-slice assumptions.** S5's Gemini error handling passed implementation and review because both used Python-shaped fakes. Only S8, testing against the real SDK, exposed it. The final full-branch review found no further cases of this class, but that is weak evidence that none remain.
- **Implementer self-reports were sometimes wrong** (S4, S8). In both cases the error was caught only because the Reviewer or the Orchestrator asked for a test. Self-reports need verification; they are not evidence.
- **The Reviewer cannot run anything.** Mutation claims and runtime facts (for example the CPython `time.sleep` thresholds) had to be spot-checked by the Orchestrator. That was done in S3, S5 and S6, not everywhere.
- **Tooling hazards.**
  - The file-writing tool, and bash heredocs, silently turned `\uXXXX` escapes into literal characters (S4–S8).
  - On Windows, `env -i py` triggered the Python install manager.
  - These cost time and created risk that had to be caught by explicit byte checks.
- **Usage limits** interrupted the run 3 times and stretched about 4 hours of active agent work across 25 hours of wall clock. Resuming agents with their context intact worked without loss each time.
- **One side effect outside the repository** (S7): the Python install manager downloaded Python into the scratchpad (since deleted) and reported "updated to 26.4". Your installed Pythons were confirmed intact. Whether the install manager itself was updated could not be determined.

### 6.3 Orchestrator errors (observed)

- **The S2 slice criterion** required evidence for invariant S2, which lives in the S8 entry point. A Reviewer found this as a blocking finding, and the plan was amended.
- **BASELINE.md §3 stated 2 Gemini retries.** The correct figure is 3 (4 attempts). It was corrected in S8.
- **One loop deviation:** the S0 R6 fix was verified by the Orchestrator instead of being re-reviewed.

### 6.4 Assumptions about the process (not verified)

- The Implementer and Reviewer are the same model family. Their blind spots may be correlated, so independent review by a different model or by a human could find issues this setup cannot.
- The final review's "no further cross-slice defects" is the judgment of one Reviewer reading about 7,400 lines of source. It is not a proof.

## 7. Architecture and maintainability observations

| Observation | Evidence |
| --- | --- |
| **The TS source is about 1.9× the Python.** | Python app 3,845 lines → TS `src/` 7,386 lines. Tests: 8,874 → 13,082 lines. |
| **About a quarter of `src/` is a Python-semantics foundation layer.** | 1,822 lines (`python-compat`, `plain-date`, `http`, `entry-point`), including line-by-line ports of CPython's `date.fromisoformat`, `email._parseaddr` and the JSON scanner. This is the price of "identical, quirks included". It is contained in a few modules and pinned by Python-generated tables. |
| **The behavior specification is now frozen.** | The goldens and fixtures can no longer be regenerated, because Python is gone. Any intended behavior change means editing the frozen reference by hand, which `tests/equivalence/README.md` treats as a spec change. |
| **Some helpers are duplicated with the same names.** | Three `externalErrorStatusCode` variants with different semantics, each faithful to a Python original. Duplicate Gemini helpers in `gemini.ts` and `people-suggest.ts`. Two copies of `PY_RE_SPACE_CLASS`. Not refactored: refactoring was out of scope. Risk: a future caller picks the wrong variant. |
| **No build step.** | Node 24 runs `.ts` directly; `tsc` only typechecks. This is simpler than the Python setup (no pip install at runtime: `npm ci --omit=dev` installs one runtime dependency). |
| **Dependencies are pinned.** | The lockfile is committed. The Python dependencies used to be unpinned (TD6, TD8). |
| **No new architectural layers or infrastructure.** | Same Slack → Vercel → GitHub Actions flow. The only new infrastructure is `ci.yml`, as approved. |

**Recommended follow-ups** (not done, all outside the experiment's scope):
- Fix the preserved defects TD1, TD7 and TD10–TD12.
- Consolidate the duplicate helpers.
- Update the stale comments in `api/slack-request.js` and in the masking step, which still name Python files.

## 8. Not validated

| Item | Why | How to validate |
| --- | --- | --- |
| **Real GitHub Actions execution of both production workflows** (U2) | `repository_dispatch` and `schedule` run only from the default branch. A manual run of the attention summary would send a real DM. | After merging, run the smoke test below. |
| **Live Slack, Notion and Gemini behavior** | Live writes are prohibited. All integration tests use fakes. | Smoke test |
| **Vercel runtime with the new package configuration** (U3) | The preview build succeeded, but the preview is behind Vercel Authentication and no credentials were available. | `vercel curl` against the preview: an unsigned POST to `/api/slack` should return 401. |
| **JSON nesting limit on Linux** | Docker and WSL were stopped. The Orchestrator chose not to start applications on your machine for an edge case of about 10,000 nesting levels. | Run `python3.12` on Linux: `json.loads("[" * 9998 + "]" * 9998)` |
| **The loud-failure path on Node < 24.2** | Only Node 24.18 is installed. | Unit-tested decision function only. |
| **`ci.yml` as a merge gate** | `main` has **no branch protection**, so CI runs on PRs but does not block a merge. | Repository setting: make the `test` check required. |

**Post-merge smoke-test checklist:**
1. `/testbot hello`: new thread with a Gemini reply.
2. A reply in that thread: a follow-up answer.
3. `/tasks list` and `/people due` in the Tasks channel.
4. `/people suggest <name>`: recap, draft and Add-interaction button.
5. Add an Interaction through the modal; then add a follow-up Task.
6. An unauthorized channel gets the refusal.
7. Run the Attention Summary workflow with `workflow_dispatch`.
8. Check that both workflow logs show no payload text and no secrets.

## 9. Success criteria (from the experiment brief)

| # | Criterion | Status |
| ---: | --- | --- |
| 1 | The application is implemented in TypeScript. | **Met** |
| 2 | Existing functionality is preserved. | **Met for all recorded behavior.** Six edge-case differences were accepted by the user (§5.2). |
| 3 | Automated tests pass. | **Met**: 1011/1011, and CI is green. |
| 4 | Security requirements are preserved. | **Met** (S1–S11 tested; reviewed per slice and end to end). |
| 5 | GitHub Actions can execute the TypeScript application. | **Met statically and in CI**: CI runs the same Node and install path. Production workflow runs are **not validated** until after merge. |
| 6 | The Reviewer identifies no unresolved critical defects. | **Met**: the final full-branch review passed with no blocking findings. |
