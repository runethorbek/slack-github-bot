# TypeScript migration — Acceptance criteria

These criteria decide when a slice is accepted, and when the migration as a whole
counts as technically successful. The reference for "existing behavior" is the
Python implementation at baseline commit `d3404ed` (see [BASELINE.md](BASELINE.md)).

## 1. What "behaviorally equivalent" means

For the same inputs (environment, injected "today", scripted HTTP and Gemini
responses), the TypeScript and Python implementations must produce the same
**observable outputs**:

| Observable | Compared how |
| --- | --- |
| Outbound HTTP calls | Same order, method, URL, headers and `timeout` value. JSON bodies are compared **semantically** (parsed), not byte for byte. |
| Slack message `text` and `blocks` | Exact string and structure equality. |
| Block Kit button `value` strings | Equal **after parsing**. The serialized length must use the Python `json.dumps` format, because the 2000-char limit is applied to it. |
| Gemini prompts | Exact string equality. |
| Notion write payloads | Exact structure equality. |
| Log lines (stdout) | Exact equality for every line Python prints deliberately (`print`). |
| Process outcome | Exit 0 vs non-zero. |
| Retry behavior | Same number of attempts and the same sleep durations, through the injected `sleep`. |

**Permitted differences.** Each one is listed in RESULTS.md, and none may weaken
anything in §3:

- The format of crash output for uncaught errors (a Python traceback vs Node output). The content must still be secret-free (§3 S7).
- The serialized whitespace and escaping of HTTP request bodies on the wire.
- HTTP timeout semantics: `requests` applies separate 10 s connect/read timeouts, while fetch applies one overall 10 s timeout.
- Gemini SDK internals: the JS SDK's own retry defaults and transport, provided the model, input and the "trailing text" semantics of `output_text` are the same.
- Behavior differences between Python 3.12 and 3.14 that no test covers. CI's 3.12 is the reference.

Any other difference counts as a defect unless the user explicitly accepts it.

## 2. Global acceptance criteria (whole migration)

| ID | Criterion | Evidence |
| --- | --- | --- |
| G1 | All runtime application logic listed in BASELINE.md §1 runs as TypeScript on Node.js. No `.py` file is executed by any workflow. | file tree, workflows |
| G2 | `npm run typecheck` (`tsc --noEmit`, `strict`) passes with zero errors. | command output |
| G3 | `npm test` passes: all ported TS tests, the equivalence tests, and the **96 existing JS tests unchanged**. | command output |
| G4 | **Test traceability.** Each of the 358 baseline Python tests maps to at least one TS test that asserts the same behavior, or to a written justification for why it does not apply (for example, a test of `runpy`-specific mechanics). The mapping table lives at `docs/experiments/typescript-migration/TEST-MAPPING.md`. | mapping table, reviewer spot checks |
| G5 | **Golden equivalence.** Every scenario in `tests/equivalence/` produces, under TypeScript, exactly the observables recorded from the unmodified Python implementation (§1). | equivalence test output |
| G6 | Every security invariant S1–S11 (§3) has at least one TS test that fails if the invariant is broken. | test names per invariant in TEST-MAPPING.md |
| G7 | Both workflows install and run the TypeScript entry points. The masking step is kept unchanged in substance. Every `env:` mapping is kept, and no new secret or payload field is exposed. | workflow diff, workflow assertion tests |
| G8 | `api/` (the Vercel layer) is unchanged, or changed only where strictly required. **Expected: no diff.** | `git diff --stat main -- api/` |
| G9 | No new external services, persistent state or architectural layers. The only new dependencies are the ones approved in PLAN.md, and the only new workflow is the approved PR CI workflow (`ci.yml`). | `package.json` diff |
| G10 | The Python runtime files and `requirements.txt` have been removed, or each leftover is listed with a reason. | file tree, RESULTS.md |
| G11 | README and the affected docs describe the TypeScript runtime accurately. | docs diff |
| G12 | The Reviewer reports no unresolved **blocking** finding on any slice or on the final full-branch review. | review records |
| G13 | No live write to Slack or Notion was made during the experiment, and no production deployment. | RESULTS.md declaration |

## 3. Security invariants (must hold after migration)

These are the same invariants as BASELINE.md §6. Each needs explicit TS test evidence (G6).

- **S1** DM authorization is an exact, case-sensitive user-ID match. An empty configured value never authorizes.
- **S2** Authorization happens before any Notion or Gemini call for `/tasks`, `/people` and `view_submission`. An unauthorized DM produces no outbound call at all. An unauthorized channel request produces only the ephemeral refusal.
- **S3** Person identity comes only from the structured payload. If it is missing, the write is a silent no-op.
- **S4** Write-time re-validation of Type, Track, Priority and the `Ikke startet` Status against live Notion. Nothing is created in the Notion schema.
- **S5** Model output never triggers a side effect. Next-step and Task suggestions are validated and bounded exactly as in Python.
- **S6** No Gemini call on `/tasks` or `/people due`. The prompt contents for suggest and the follow-up suggestion are exactly equal to Python's.
- **S7** No secret, token, response URL, Slack text, Notion data, prompt or model output in stdout/stderr on any path, including **uncaught errors**. TS entry points must catch top-level errors and print only a secret-free message, with no `cause` chain, no request URL with query or body, and no response body.
- **S8** The masking step and the `$GITHUB_ENV` export of the response URL are kept.
- **S9** Task create retries only on 429. A 5xx, timeout or network error gives the "may not have been added" message.
- **S10** Every bound in BASELINE.md §6 S10 is kept, measured in **Python units** (code points; Python `json.dumps` format for button values).
- **S11** Notion credential failures fail the run where Python fails it, and degrade where Python degrades.

## 4. Per-slice acceptance

A slice is **accepted** when all of the following hold:

1. Its slice-specific criteria in PLAN.md are met.
2. `npm run typecheck` passes.
3. `npm test` passes, and the Python suite (`python -m unittest discover -s tests -p "test_*.py"`) still passes for any Python that still exists.
4. The ported tests for the slice's Python module(s) are complete, and they are recorded in TEST-MAPPING.md.
5. The slice's golden scenarios pass, where applicable.
6. The Reviewer reports no unresolved **blocking** finding. Each **should-fix** finding is either fixed or recorded with a reason in RESULTS.md.
7. The diff contains no out-of-scope changes, and no existing test was deleted or weakened except as recorded in the mapping (G4).

**Iteration limit.** At most 5 implementation→review cycles per slice. A sixth
cycle triggers the stop condition: the slice is marked blocked and reported.

**Finding severities** (the Reviewer's scale):

- **blocking**: an acceptance criterion is not met, or there is a correctness bug, a behavioral difference outside §1's permitted list, a security regression, a new test failure, or a material scope violation.
- **should-fix**: a concrete, likely problem that does not break acceptance.
- **nit**: style.

## 5. Things that cannot be validated in this experiment

These are declared in advance so they are not mistaken for verified behavior:

- **Real GitHub Actions execution.** `repository_dispatch` and `schedule` only trigger workflows on the default branch. A `workflow_dispatch` of the attention summary would send a real Slack DM, which is a live write and prohibited. The workflows are validated statically, plus a local run of the exact install and entry commands with fake configuration and no network side effects.
- **Live Slack, Notion and Gemini behavior.** All integration tests use injected fakes. Notion API version semantics and the real `@google/genai` Interactions response shape are validated against SDK source and types, not live calls.
- **Vercel.** Not deployed. G8 ensures it is unaffected, except for one possible effect of a committed lockfile on Vercel's install step (see PLAN.md, decision D1).
