# TypeScript migration — Plan

Status: **Approved 2026-10-13 with modifications (see §9). Phase 2 in progress.**
Companion documents: [BASELINE.md](BASELINE.md) and [ACCEPTANCE.md](ACCEPTANCE.md).

## 1. Goal and constraints

Migrate the Python application logic (`main.py`, `attention_summary.py` and their
six library modules, plus the two dev scripts) to TypeScript on Node.js. GitHub
Actions remains the runtime. External behavior, security boundaries and the Vercel
layer stay as they are.

Constraints, from the experiment brief and AGENTS.md:

- Behavior is preserved, including authorization, error handling, user-facing text and external API contracts. Observed quirks are preserved and documented, not fixed (BASELINE.md §7).
- No migration to Vercel Functions. `api/` stays as it is.
- No new infrastructure, persistent state or architectural layers. Dependencies only as approved (§8).
- No live Slack or Notion writes, and no deployment. The PR is not merged.
- Tests are not deleted or weakened to make validation pass. Python tests are retired only after each one is traced to a TS equivalent (ACCEPTANCE.md G4).

## 2. Target architecture

### Runtime and tooling

- **Node 24 LTS. TypeScript runs directly through Node's built-in type stripping, with no build step and no `dist/`.** Verified locally on Node 24.18: `node src/x.ts` runs without warnings, and the existing `node --test` command discovers both `*.test.ts` and `*.test.js`.
- The `tsconfig.json` settings this requires: `strict`, `noEmit`, `erasableSyntaxOnly`, `allowImportingTsExtensions`, `module`/`moduleResolution: nodenext`, `verbatimModuleSyntax`, and `include: ["src", "tests"]`. Erasable-only means no `enum`, no `namespace` and no constructor parameter properties. `CadenceStatus` becomes a string-literal union plus a `const` object.
- `package.json` scripts: `typecheck` (`tsc --noEmit`). `test` stays `node --test`, which now also runs the `.ts` tests.
- Dependencies (decision D1): runtime `@google/genai` (exact pin); dev `typescript` and `@types/node@24` (exact pins); a committed `package-lock.json`. Slack and Notion use the built-in `fetch`, so no HTTP library is needed.

### Layout

Each Python module maps one-to-one to a TS module. The file names follow the
kebab-case convention already used in `api/`.

| Python | TypeScript |
| --- | --- |
| `slack_authorization.py` | `src/slack-authorization.ts` |
| `tasks_list.py` | `src/tasks-list.ts` |
| `people_due.py` | `src/people-due.ts` |
| `people_interaction.py` | `src/people-interaction.ts` |
| `people_suggest.py` | `src/people-suggest.ts` |
| `followup_task.py` | `src/followup-task.ts` |
| `attention_summary.py` | `src/attention-summary.ts` (entry: `node src/attention-summary.ts`) |
| `main.py` | `src/main.ts` (entry: `node src/main.ts`) |
| *(new, foundation)* | `src/python-compat.ts`: Python-semantics helpers (BASELINE.md §8) |
| *(new, foundation)* | `src/plain-date.ts`: timezone-free date type, `fromisoformat` replicas, calendar-month arithmetic, `copenhagenToday` |
| *(new, foundation)* | `src/http.ts`: a requests-like adapter over `fetch` |
| *(new)* | `src/gemini.ts`: `generateGeminiText` via `@google/genai`, plus status-code extraction |
| `scripts/*.py` | `scripts/*.ts` |
| `tests/test_*.py` | `tests/*.test.ts` |

The circular import `people_due` ↔ `people_suggest` is resolved the same way
Python resolves it: ES modules tolerate the cycle when the binding is only used at
call time. If the cycle causes problems, a dynamic `import()` mirrors Python's lazy
import.

### Design rules that keep the port reviewable

1. **Keep the Python dependency-injection shape.** Every handler takes the same injected collaborators it does now (`notion_post`, `notion_get`, `post_slack_message`, `generate_text`, `environment`, `today`, `sleep`). The only change is camelCase names, and the functions become `async`. The ported tests can then assert the same calls with the same arguments, almost line for line.
2. **`src/http.ts` reproduces the `requests` surface the code relies on.** That means `post(url, {headers, json, timeout})` / `get(url, {headers, params, timeout})` returning `{status_code, headers, json(), raise_for_status()}`. Errors carry `.response.status_code`, and they are classified as `Timeout` / `ConnectionError` for `is_retryable_notion_error`. Behavior that depends on the error type then ports without being redesigned.
3. **Python-semantics helpers are explicit, named and tested against Python output.** Examples are `casefold`, `pyStrip`, `pySplitWhitespace`, `pyLen` / `pyTruncate` (code points), `pyJsonDumps` (`", "`/`": "` separators, `ensure_ascii`), `pyFloat`, `parseHttpDate`, and the `date.fromisoformat` / `datetime.fromisoformat().date()` replicas. No TS module calls `toLowerCase`, `trim`, `.length`-based truncation or `JSON.stringify` where the Python code relies on Python semantics.
4. **Entry points own process concerns.** That means reading the environment (a missing required variable fails like `KeyError` does), `process.exitCode`, and one top-level `catch` that prints only a secret-free message, as Python's `from None` messages do, before exiting 1 (security invariant S7).
5. **No new behavior, no cleanup.** Legacy `find_one_due_person` is ported, because tests pin it. Quirks stay.

### Workflows (after cutover)

```yaml
- uses: actions/checkout@v5
- uses: actions/setup-node@<current major>
  with: { node-version: "24" }
- run: npm ci --omit=dev
- <masking step unchanged>            # slack-message.yml only
- run: node src/main.ts               # env: mapping unchanged
```

`attention-summary.yml` changes the same way, to `node src/attention-summary.ts`.
The `env:` mappings, the masking step, triggers and the cron schedule are not touched.

## 3. Behavioral equivalence strategy

There are three layers, from fine to coarse. Each one is independent evidence for the Reviewer.

1. **Ported unit tests (G4).** All 358 Python tests are ported to `node:test` with the same fixtures, inputs and assertions. `TEST-MAPPING.md` maps each Python test ID to its TS test name(s). Any test that does not apply has a written justification.
2. **Golden scenarios recorded from Python (G5).** These are created in Slice 1, *before any TS logic exists*, so they come from the untouched baseline.
   - `tests/equivalence/scenarios/*.json` holds about 35 end-to-end scenarios: entry point, environment, fixed "today", and scripted HTTP and Gemini responses or errors. They cover the full routing matrix in BASELINE.md §5, every write path, all failure/retry/credential branches, and every outcome of the attention summary.
   - `tests/equivalence/record_python.py` is test-only tooling. It runs the real Python entry point in-process with fake `requests` and `google.genai` (the same technique `test_main_routing.py` already uses), and writes `golden/<name>.json` containing the calls, prompts, stdout lines and exit code.
   - `tests/equivalence.test.ts` replays each scenario against the TS entry point and compares the observables as defined in ACCEPTANCE.md §1.
   - The goldens are committed, so they stay as the frozen reference after the Python code is removed.
3. **Python-semantics golden table.** Python generates a table of inputs and outputs for each compat helper (casefold, strip/split, code-point truncation, `json.dumps`, `float`, `fromisoformat` acceptance, `add_calendar_months`, `retry_delay` parsing). The inputs include Danish letters, `ß`, emoji, edge whitespace, malformed dates and Retry-After variants. The `python-compat` tests then check the TS helpers against the table.

## 4. Slices

Every slice leaves the branch in a working state. Until the cutover slices (S7,
S8), the workflows still run Python, so each TS module is additive. The workflows
only run from the default branch, so nothing on the migration branch executes in
GitHub before merge.

| # | Slice | Scope | Slice-specific acceptance | Depends on |
| --- | --- | --- | --- | --- |
| S0 | **Toolchain, CI and foundations** | `tsconfig.json`, package scripts, dependencies and lockfile (installed by the orchestrator per D1/D4), the PR CI workflow `.github/workflows/ci.yml` (§9), `src/python-compat.ts`, `src/plain-date.ts`, `src/http.ts`, and their tests. Includes generating the Python-semantics golden table. | typecheck runs; the helpers match the Python table; the `http.ts` error and timeout classification is tested; the 96 JS tests still pass; `api/` is unchanged | — |
| S1 | **Golden recorder and scenarios** | The Python recorder, the scenario set and the committed goldens. No TS logic. | about 35 scenarios that together cover every routing branch and every S-invariant; recording is deterministic (two runs give the same output); no production code is changed | — |
| S2 | `slack-authorization` + `tasks-list` | Ports these modules, including the shared Notion retry and delay core, plus their tests (28). | the ported tests pass; S1, S10 and S11 have tests (invariant S2 is evidenced in S8; see §9 amendment) | S0 |
| S3 | `people-due` | Ports the module and its 56 tests, including legacy `find_one_due_person`. | the ported tests pass; calendar-month arithmetic matches the Python table | S2 |
| S4 | `people-interaction` | Ports the module and its 39 tests (**write path**). | S3 and S4 have tests; the write payload exactly equals Python's; retry behavior is kept, including quirk 2 | S3 |
| S5 | `people-suggest` | Ports the module and its 110 tests, including byte-exact prompts. | prompts exactly equal Python's; next-step parsing tests pass; S5, S6 and S10 have tests | S4 |
| S6 | `followup-task` | Ports the module and its 53 tests (**write path** plus Gemini suggestion). | S4, S5 and S9 have tests; button-value limit measured with `pyJsonDumps` | S4 |
| S7 | `attention-summary` entry + **workflow cutover** | Ports the module, its 36 tests and its golden replay; switches `attention-summary.yml` to Node. | the attention goldens pass; the workflow diff contains only the runtime steps; a local dry run with fake config exits as Python does | S2, S3 |
| S8 | `gemini` + `main` entry + **workflow cutover** | Ports `src/gemini.ts`, `src/main.ts`, the 32 routing tests, the 4 cross-layer contract tests (now in-process, importing `api/slack-request.js` directly) and the main goldens; switches `slack-message.yml`. | all main goldens pass; S2 (authorization before any Notion/Gemini call) is tested at the entry point; S7 is tested by forcing uncaught errors; workflow assertion tests are updated to the new workflow without losing any assertion | S2–S6 |
| S9 | **Retire Python, port scripts, docs** | Ports `scripts/*.py`; removes the Python modules, Python tests, `requirements.txt` and the recorder (the goldens stay); updates README, AGENTS.md wording ("Python" → "TypeScript application code") and `docs/people-suggest-gemini-context.md`; completes TEST-MAPPING.md. | G1, G4, G10 and G11 met; nothing references the removed files | S7, S8 |

After S9 come Phase 3 (independent validation, including a final full-branch
review) and Phase 4 (RESULTS.md and the PR).

## 5. Agentic workflow

| Role | Who | Tools | Responsibilities |
| --- | --- | --- | --- |
| Orchestrator | this session | all | Owns the plan and git (branch, commits). Installs dependencies (S0). Writes each slice brief. Runs typecheck and tests itself and passes the **actual** results to the Reviewer. Decides on findings. Keeps the metrics log. |
| Implementer | `slice-implementer` subagent (`~/.claude/agents/`) | everything except Agent; may not use git write commands or add dependencies | Implements one slice and its tests; on resume, fixes only the findings it is given. |
| Reviewer | `slice-reviewer` subagent | **Read, Grep and Glob only.** It cannot edit or run anything, so "the Reviewer must not edit" is enforced by its tools, not just by instruction. | Reviews the slice diff against ACCEPTANCE.md, the Python reference and the S-invariants. |

The loop for each slice: write the brief → Implementer → orchestrator runs
`npm run typecheck`, `npm test` and the Python suite → the diff is written to a
scratch file → Reviewer → triage of findings → (resume the Implementer with the
blocking findings, then re-review) ≤ 5 cycles → commit
`TS migration S<n>: <title>` → record metrics.

Slices run **sequentially**, with no parallel implementers. That keeps the diffs
attributable and the metrics clean.

**Metrics captured per slice** (raw data for RESULTS.md): wall-clock start and end;
number of implementer runs; number of review rounds; findings by severity, and how
each was resolved (fixed autonomously, rejected with evidence, or escalated);
human interventions; test counts. **Token usage and cost are not visible to the
orchestrator.** RESULTS.md will report them only if the user supplies them (for
example from `/cost` or the console). They will not be estimated.

## 6. Risks

| Risk | Impact | Mitigation |
| --- | --- | --- |
| Silent drift in Python semantics (BASELINE.md §8) | Wrong sorting, truncation, dates or name matching | The `python-compat` helpers and the Python golden table; review focus |
| `@google/genai` Interactions API shape differs from Python (`output_text`, error `.status`, implicit `GEMINI_API_KEY`, retries) | Gemini path breaks or classifies errors wrongly | Verify against the installed SDK's types and source in S8; normalize status extraction in `gemini.ts`; record any remaining retry difference as a permitted difference |
| Uncaught Node errors print `cause` chains or fetch URLs | Data leaking into logs (S7) | Top-level handler in both entry points, with dedicated tests |
| Port of the 358 tests loses assertions | Weakened verification | TEST-MAPPING.md and reviewer spot checks; assertion counts compared per file |
| The workflows cannot be run before merge | The cutover is unverified at runtime | Static validation, workflow assertion tests and a local dry run of the exact commands; listed as unvalidated in RESULTS.md, with a smoke-test checklist for the user to run after merge |
| A committed lockfile changes Vercel's install (`@vercel/functions` pinned instead of `latest`) | Unintended Vercel change | Called out in D1; `api/` code is unchanged; the user can check a Vercel preview |
| A root `tsconfig.json` may be picked up by Vercel's builder | Vercel build behavior changes | Limit `include` to `src` and `tests`; flag for a preview check |
| Erasable-syntax restrictions or TS 7 tooling quirks | Friction in S0 | Validated on a probe already; pin exact versions |
| Long slices (S5 has 110 tests and 928 lines of source) exceed one implementer context | More iterations | If S5 hits its cycle limit, split it into S5a (resolution and context) and S5b (prompts, next step and blocks), recorded as a plan change |
| Stop condition: more than 5 cycles on a slice | Blocked migration | Stop and report, as the brief requires |

## 7. Unknowns to resolve during implementation

| ID | Unknown | Resolved in | How |
| --- | --- | --- | --- |
| U1 | The exact `@google/genai` Interactions API: method, `output_text`, error class and status field | S8 (checked first) | Read the pinned package's `.d.ts` and source. If it is unavailable or incompatible, **stop and ask**. Falling back to raw REST would be a design change. |
| U2 | Whether `npm ci --omit=dev` plus native `.ts` execution behaves the same on `ubuntu-latest` with `setup-node` 24 | S7 | Local dry run; static review; post-merge smoke test (user) |
| U3 | Whether Vercel is affected by the lockfile and `tsconfig.json` | — | Cannot be checked without a deploy; flagged for the user |
| U4 | Behavior differences in `fromisoformat` / `casefold` between Python 3.12 and 3.14 | S0/S1 | Generate the golden tables under 3.12 if it can be installed locally; otherwise document that 3.14 was used |

## 8. Decisions requiring approval

| ID | Decision | Recommendation |
| --- | --- | --- |
| D1 | **New dependencies**: runtime `@google/genai`; dev `typescript` and `@types/node`; commit `package-lock.json` (this also pins `@vercel/functions` for Vercel). | Approve. The official SDK is the closest equivalent of the Python SDK. Raw REST would mean re-implementing its retries and `output_text`. |
| D2 | **Native type stripping on Node 24, with no build step.** | Approve. It has the fewest moving parts and matches the existing `node --test`. |
| D3 | **Remove Python in the same PR** (S9), keeping the Python-recorded goldens as the permanent reference. | Approve. It is required for success criterion 1, and the goldens preserve the reference. |
| D4 | **Use the `slice-implementer` / `slice-reviewer` agents outside `/build-slice`** (that skill is not available in this session). The orchestrator installs the dependencies, because the implementer's rules forbid it. | Approve. |
| D5 | ~~No new CI test workflow.~~ **Reversed at approval: add a PR CI workflow (see §9).** | — |
| D6 | **Commit Phase 1 documents as the first commit on branch `experiment/typescript-migration`.** No GitHub issue is created for the experiment, because this brief is the specification. | Approve. A tracking issue is optional, and creating one is a GitHub write that would need your go-ahead. |
| D7 | **Quirks in BASELINE.md §7 are preserved**, including Interaction create retrying 5xx. | Approve. Fixes belong in separate issues after the experiment. |

## 9. Approval record and modifications (2026-10-13)

The user approved D1–D4, D6 and D7 as proposed, with the following changes:

- **D5 reversed.** Add `.github/workflows/ci.yml`, triggered on `pull_request`. It must be independent of the Slack workflows and use no secrets. It runs `npm ci`, `npm run typecheck`, `npm test` and, while Python modules exist, the Python unittest suite. Any failure fails the job. It is added in S0 so that every later slice is validated by it once the PR exists.
- **Execution log.** `EXECUTION_LOG.md` is updated after each slice with what was actually observed.
- **Static typechecking is enforced independently** of native type stripping: `tsc --noEmit` with `strict`, run in CI and before every review.
- **Existing defects are preserved** and documented separately in [TECH-DEBT.md](TECH-DEBT.md).
- **Deployment safety.** No production deploy. To check that the package changes don't break Vercel, the branch is pushed and a draft PR opened right after S0; Vercel's Git integration builds a preview of the branch if it is enabled. Its status is read with `gh api`. If no preview is produced, that is recorded as not validated.
- **Autonomy.** Slices S0–S9 proceed with no approval checkpoints. Execution stops only on a stop condition from the brief.
- **Final evaluation** keeps four questions separate: technical migration success, functional equivalence, autonomous completion, and quality of the agentic process.

**Amendment, S2 review (2026-10-13 15:20).** The S2 slice criterion required tests for security invariant S2 (authorization before any Notion or Gemini call). That invariant is enforced in `main.py`'s routing order, which is ported in S8, not S2. This was a planning defect by the Orchestrator, caught by the Reviewer as a blocking finding. The S2 evidence requirement moved to the S8 row. The handlers ported in S2 do not authorize, just as their Python originals don't.
