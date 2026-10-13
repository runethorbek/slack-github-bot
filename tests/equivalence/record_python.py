"""Record end-to-end golden observables from the unmodified Python entry points.

Run with the CI reference Python (3.12):

    py -3.12 tests/equivalence/record_python.py          # write golden/<name>.json
    py -3.12 tests/equivalence/record_python.py --check  # verify, write nothing

Each ``scenarios/<name>.json`` names an entry point (``main`` or
``attention_summary``), a frozen Copenhagen "today", an exact environment and
two ordered scripts: one for outbound HTTP calls and one for Gemini calls. The
scenario runs in-process against the real entry point, and the observables
(HTTP calls, Gemini calls, sleeps, stdout lines and the exit outcome) are
written to ``golden/<name>.json``. tests/equivalence/README.md describes the
formats.

How the boundaries are faked:

- HTTP: the real ``requests.post`` / ``requests.get`` are replaced. Each call
  consumes the next scripted entry, whose ``expect.method`` and ``expect.url``
  must match. A scripted response becomes a real ``requests.Response`` (status,
  body, headers, url, reason), so ``raise_for_status()`` and ``.json()`` behave
  as they do in production. A scripted error raises the real
  ``requests.exceptions`` class. ``requests.request``, ``Session.request`` and
  ``socket.connect`` are blocked, so nothing reaches the network.
- Gemini: ``google.genai.Client`` is replaced by a fake whose
  ``interactions.create(model=..., input=...)`` returns an object with the
  scripted ``output_text``, or raises the real SDK exception.

  SDK finding (google-genai 2.30.0, the version installed for Python 3.12 when
  this was written): ``Client.interactions`` is
  ``google.genai._gaos.google_genai.GeminiNextGenInteractions``. Its ``create``
  runs the generated call through ``_gaos.lib.compat_errors.wrap_sdk_call``,
  which turns an HTTP error into the Stainless-compatible
  ``compat_errors.APIStatusError`` subclass for the status
  (``RateLimitError`` for 429, ``AuthenticationError`` for 401,
  ``InternalServerError`` for 5xx, ...). Those carry ``.status_code`` and
  ``.response`` (an ``httpx.Response``), not the ``google.genai.errors.APIError``
  ``.code``. The recorder builds the error with ``compat_errors.APIError.generate``,
  exactly as the SDK does, so ``external_error_status_code`` takes its real
  ``error.response.status_code`` path. If a later SDK moves that module, the
  recorder fails loudly instead of guessing.
- Time: ``time.sleep`` is replaced by a recorder before any application module
  is imported (several functions bind ``sleep=time.sleep`` as a default at
  definition time). ``tasks_list.copenhagen_today`` is frozen before the other
  modules import it by name, and every loaded module's binding is verified.
  The application modules are purged from ``sys.modules`` before each scenario.

A call that is not in the script, or that does not match its entry, raises
``ScriptViolation``. It derives from BaseException so the application's
``except Exception`` handlers cannot swallow it. Unconsumed script entries are
also a failure.

Secret canaries: every scenario uses the canary values listed in CANARIES. The
recorder fails if any of them appears in stdout, stderr, an uncaught
exception message or that exception's full formatted traceback (the chain
Python would print to stderr), unless the scenario declares a ``known_leak`` note (none
does at the time of writing). This records invariant S7 for the Python
baseline.
"""

import contextlib
import copy
import http
import importlib.metadata
import io
import json
import os
import re
import runpy
import socket
import sys
import time
import traceback
from datetime import date
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
EQUIVALENCE_DIR = Path(__file__).resolve().parent
SCENARIOS_DIR = EQUIVALENCE_DIR / "scenarios"
GOLDEN_DIR = EQUIVALENCE_DIR / "golden"
sys.path.insert(0, str(REPO_ROOT))

import requests  # noqa: E402
import google.genai  # noqa: E402

APPLICATION_MODULES = (
    "main",
    "attention_summary",
    "followup_task",
    "people_suggest",
    "people_interaction",
    "people_due",
    "tasks_list",
    "slack_authorization",
)

# Imported in dependency order after tasks_list.copenhagen_today is frozen.
LIBRARY_MODULES = (
    "slack_authorization",
    "people_due",
    "people_interaction",
    "people_suggest",
    "followup_task",
    "attention_summary",
)

CANARIES = (
    "xoxb-CANARY-SLACK-TOKEN",
    "secret_CANARY_NOTION_KEY",
    "CANARY-GEMINI-KEY",
    "CANARY-RESPONSE-URL",
    "CANARY-PRIVATE",
)

HTTP_ERRORS = {
    "ReadTimeout": requests.exceptions.ReadTimeout,
    "ConnectTimeout": requests.exceptions.ConnectTimeout,
    "ConnectionError": requests.exceptions.ConnectionError,
}

GEMINI_ERROR_URL = "https://generativelanguage.googleapis.com/v1beta/interactions"

SCENARIO_KEYS = {"name", "description", "entrypoint", "today", "env", "http", "gemini"}
OPTIONAL_SCENARIO_KEYS = {"known_leak"}
HTTP_CALL_KEYWORDS = {"headers", "json", "params", "timeout"}
NUMERIC_RETRY_AFTER = re.compile(r"^[0-9]+(\.[0-9]+)?$")

# The google-genai version whose error classes the goldens were checked
# against. Another version only warns: the goldens hold no SDK detail beyond
# the status code, but the error construction above should be re-checked.
GOLDEN_GENAI_VERSION = "2.30.0"


class ScriptViolation(BaseException):
    """The application made a call the scenario script does not allow."""


class RecorderError(Exception):
    """A scenario could not be recorded; the message says why."""


def gemini_status_error(status):
    """Build the exception the installed SDK raises for an HTTP error status."""
    try:
        import httpx
        from google.genai._gaos.lib.compat_errors import APIError
    except ImportError as error:
        raise RecorderError(
            "The installed google-genai no longer provides "
            "_gaos.lib.compat_errors; re-check which exception "
            "client.interactions.create raises before recording."
        ) from error
    response = httpx.Response(
        status, request=httpx.Request("POST", GEMINI_ERROR_URL)
    )
    return APIError.generate(
        status_code=status, body=None, message=None, response=response
    )


class Recorder:
    def __init__(self, scenario):
        self.scenario = scenario
        self.http_script = list(scenario["http"])
        self.gemini_script = list(scenario["gemini"])
        self.http_calls = []
        self.gemini_calls = []
        self.sleeps = []
        self.violations = []

    def violate(self, message):
        self.violations.append(message)
        raise ScriptViolation(message)

    # HTTP -----------------------------------------------------------------

    def http_call(self, method, url, kwargs):
        unexpected = set(kwargs) - HTTP_CALL_KEYWORDS
        if unexpected:
            self.violate(f"{method} {url}: unexpected keyword(s) {sorted(unexpected)}")
        call_number = len(self.http_calls) + 1
        self.http_calls.append(
            {
                "method": method,
                "url": url,
                "params": copy.deepcopy(kwargs.get("params")),
                "headers": copy.deepcopy(kwargs.get("headers")),
                "json": copy.deepcopy(kwargs.get("json")),
                "timeout": kwargs.get("timeout"),
            }
        )
        if not self.http_script:
            self.violate(f"HTTP call {call_number} ({method} {url}) is not in the script")
        entry = self.http_script.pop(0)
        expect = entry["expect"]
        if expect["method"] != method or expect["url"] != url:
            self.violate(
                f"HTTP call {call_number} was {method} {url}, "
                f"script expects {expect['method']} {expect['url']}"
            )
        if "error" in entry:
            error_class = HTTP_ERRORS.get(entry["error"])
            if error_class is None:
                self.violate(f"Unknown scripted HTTP error {entry['error']!r}")
            raise error_class("Scripted network failure.")
        return build_response(url, entry["response"])

    def post(self, url, **kwargs):
        return self.http_call("POST", url, kwargs)

    def get(self, url, **kwargs):
        return self.http_call("GET", url, kwargs)

    # Gemini ---------------------------------------------------------------

    def gemini_create(self, kwargs):
        if set(kwargs) != {"model", "input"}:
            self.violate(f"Gemini call with unexpected arguments {sorted(kwargs)}")
        call_number = len(self.gemini_calls) + 1
        self.gemini_calls.append({"model": kwargs["model"], "input": kwargs["input"]})
        if not self.gemini_script:
            self.violate(f"Gemini call {call_number} is not in the script")
        entry = self.gemini_script.pop(0)
        if "error" in entry:
            raise gemini_status_error(entry["error"]["status"])
        return GeminiResponse(entry["output_text"])

    def gemini_client_class(self):
        recorder = self

        class FakeInteractions:
            def create(self, *args, **kwargs):
                if args:
                    recorder.violate("Gemini call with positional arguments")
                return recorder.gemini_create(kwargs)

        class FakeClient:
            def __init__(self, *args, **kwargs):
                if args or kwargs:
                    recorder.violate("genai.Client created with arguments")
                self.interactions = FakeInteractions()

        return FakeClient

    # Time -----------------------------------------------------------------

    def sleep(self, seconds):
        self.sleeps.append(seconds)


class GeminiResponse:
    def __init__(self, output_text):
        self.output_text = output_text


def build_response(url, spec):
    response = requests.Response()
    response.status_code = spec["status"]
    response.url = url
    try:
        response.reason = http.HTTPStatus(spec["status"]).phrase
    except ValueError:
        response.reason = ""
    response.headers = requests.structures.CaseInsensitiveDict(spec.get("headers", {}))
    if "json" in spec:
        response._content = json.dumps(spec["json"], ensure_ascii=False).encode("utf-8")
    elif "text" in spec:
        response._content = spec["text"].encode("utf-8")
    else:
        response._content = b""
    response.encoding = "utf-8"
    return response


def blocked_network(*args, **kwargs):
    raise ScriptViolation("Network access outside the scripted requests.post/get")


@contextlib.contextmanager
def patched(target, name, value):
    original = getattr(target, name)
    setattr(target, name, value)
    try:
        yield
    finally:
        setattr(target, name, original)


@contextlib.contextmanager
def scenario_environment(env):
    original = dict(os.environ)
    os.environ.clear()
    os.environ.update(env)
    try:
        yield
    finally:
        os.environ.clear()
        os.environ.update(original)


def purge_application_modules():
    for name in APPLICATION_MODULES:
        sys.modules.pop(name, None)


def load_application_modules(frozen_today):
    """Import the library modules with the frozen clock already in place."""
    import importlib

    tasks_list = importlib.import_module("tasks_list")
    tasks_list.copenhagen_today = lambda: frozen_today
    modules = [tasks_list] + [importlib.import_module(name) for name in LIBRARY_MODULES]
    for module in modules:
        bound = getattr(module, "copenhagen_today", None)
        if bound is not None and bound is not tasks_list.copenhagen_today:
            raise RecorderError(f"{module.__name__}.copenhagen_today is not frozen")
    return {module.__name__: module for module in modules}


def run_entrypoint(entrypoint, modules):
    """Run the entry point; return (exit code, uncaught exception or None)."""
    try:
        if entrypoint == "main":
            runpy.run_module("main", run_name="__main__")
        elif entrypoint == "attention_summary":
            sys.exit(modules["attention_summary"].main())
        else:
            raise RecorderError(f"Unknown entrypoint {entrypoint!r}")
    except SystemExit as exit_signal:
        code = exit_signal.code
        if code is None:
            return 0, None
        if not isinstance(code, int):
            raise RecorderError(f"Non-integer exit code {code!r}")
        return code, None
    except ScriptViolation:
        raise
    except RecorderError:
        raise
    except Exception as error:  # an uncaught application exception
        return 1, error
    return 0, None


def record_scenario(scenario):
    validate_scenario(scenario)
    recorder = Recorder(scenario)
    frozen_today = date.fromisoformat(scenario["today"])
    stdout = io.StringIO()
    stderr = io.StringIO()

    purge_application_modules()
    try:
        with contextlib.ExitStack() as stack:
            stack.enter_context(scenario_environment(scenario["env"]))
            stack.enter_context(patched(time, "sleep", recorder.sleep))
            stack.enter_context(patched(requests, "post", recorder.post))
            stack.enter_context(patched(requests, "get", recorder.get))
            stack.enter_context(patched(requests, "request", blocked_network))
            stack.enter_context(
                patched(requests.Session, "request", blocked_network)
            )
            stack.enter_context(patched(socket.socket, "connect", blocked_network))
            stack.enter_context(
                patched(google.genai, "Client", recorder.gemini_client_class())
            )
            modules = load_application_modules(frozen_today)
            stack.enter_context(contextlib.redirect_stdout(stdout))
            stack.enter_context(contextlib.redirect_stderr(stderr))
            code, uncaught = run_entrypoint(scenario["entrypoint"], modules)
    except ScriptViolation as violation:
        raise RecorderError(f"script violation: {violation}") from None
    finally:
        purge_application_modules()

    if recorder.violations:
        raise RecorderError(f"script violation: {recorder.violations[0]}")
    if recorder.http_script:
        raise RecorderError(f"{len(recorder.http_script)} scripted HTTP entries unused")
    if recorder.gemini_script:
        raise RecorderError(f"{len(recorder.gemini_script)} scripted Gemini entries unused")
    if stderr.getvalue():
        raise RecorderError(f"unexpected stderr output: {stderr.getvalue()!r}")

    exit_outcome = {"code": code}
    if uncaught is not None:
        exit_outcome["uncaught"] = {
            "type": type(uncaught).__name__,
            "message": str(uncaught),
        }

    stdout_text = stdout.getvalue()
    stdout_lines = stdout_text.split("\n")
    if stdout_lines[-1] == "":
        stdout_lines.pop()

    check_canaries(scenario, stdout_text, stderr.getvalue(), uncaught)

    return {
        "exit": exit_outcome,
        "gemini_calls": recorder.gemini_calls,
        "http_calls": recorder.http_calls,
        "sleeps": recorder.sleeps,
        "stdout": stdout_lines,
    }


def check_canaries(scenario, stdout_text, stderr_text, uncaught):
    exposed = {"stdout": stdout_text, "stderr": stderr_text}
    if uncaught is not None:
        exposed["uncaught exception message"] = str(uncaught)
        # The full chain Python would print to stderr for an uncaught error.
        exposed["uncaught traceback"] = "".join(traceback.format_exception(uncaught))
    leaks = [
        f"{canary} in {where}"
        for where, text in exposed.items()
        for canary in CANARIES
        if canary in text
    ]
    if leaks and "known_leak" not in scenario:
        raise RecorderError("secret canary leaked: " + "; ".join(leaks))


def validate_scenario(scenario):
    keys = set(scenario)
    missing = SCENARIO_KEYS - keys
    unknown = keys - SCENARIO_KEYS - OPTIONAL_SCENARIO_KEYS
    if missing or unknown:
        raise RecorderError(
            f"scenario keys: missing {sorted(missing)}, unknown {sorted(unknown)}"
        )
    for entry in scenario["http"]:
        if set(entry) not in ({"expect", "response"}, {"expect", "error"}):
            raise RecorderError(f"malformed HTTP script entry {entry!r}")
        if set(entry["expect"]) != {"method", "url"}:
            raise RecorderError(f"malformed HTTP expect {entry['expect']!r}")
        headers = entry.get("response", {}).get("headers", {})
        for header, value in headers.items():
            if header.lower() == "retry-after" and not NUMERIC_RETRY_AFTER.match(value):
                raise RecorderError(
                    f"Retry-After {value!r} is not numeric; HTTP dates depend on the wall clock"
                )
    for entry in scenario["gemini"]:
        if set(entry) not in ({"output_text"}, {"error"}):
            raise RecorderError(f"malformed Gemini script entry {entry!r}")
    if not all(isinstance(value, str) for value in scenario["env"].values()):
        raise RecorderError("environment values must be strings")


def render(golden):
    return json.dumps(golden, sort_keys=True, ensure_ascii=True, indent=2) + "\n"


def load_scenarios():
    scenarios = []
    for path in sorted(SCENARIOS_DIR.glob("*.json")):
        scenario = json.loads(path.read_text(encoding="utf-8"))
        if scenario.get("name") != path.stem:
            raise RecorderError(f"{path.name}: name must equal the file name")
        scenarios.append(scenario)
    return scenarios


def main(argv):
    if sys.version_info[:2] != (3, 12):
        print("This recorder must run on Python 3.12, the CI reference version.")
        return 2
    check = "--check" in argv
    genai_version = importlib.metadata.version("google-genai")
    if genai_version != GOLDEN_GENAI_VERSION:
        print(
            f"Warning: google-genai {genai_version} is installed; the goldens were "
            f"checked against {GOLDEN_GENAI_VERSION}. Re-check the Gemini error classes."
        )
    failures = []
    rendered = {}
    for scenario in load_scenarios():
        try:
            rendered[scenario["name"]] = render(record_scenario(scenario))
        except RecorderError as error:
            failures.append(f"{scenario['name']}: {error}")
    for failure in failures:
        print(f"Recording failed: {failure}")
    if failures:
        return 1

    if check:
        stale = []
        for name, content in rendered.items():
            path = GOLDEN_DIR / f"{name}.json"
            if not path.exists() or path.read_text(encoding="utf-8") != content:
                stale.append(name)
        orphaned = sorted(
            path.stem
            for path in GOLDEN_DIR.glob("*.json")
            if path.stem not in rendered and path.name != "python-compat.json"
        )
        for name in stale:
            print(f"Golden is missing or out of date: {name}")
        for name in orphaned:
            print(f"Golden has no scenario: {name}")
        if stale or orphaned:
            return 1
        print(f"All {len(rendered)} scenario goldens are up to date.")
        return 0

    GOLDEN_DIR.mkdir(parents=True, exist_ok=True)
    for name, content in rendered.items():
        with (GOLDEN_DIR / f"{name}.json").open("w", encoding="utf-8", newline="\n") as handle:
            handle.write(content)
    print(f"Wrote {len(rendered)} scenario goldens to {GOLDEN_DIR.relative_to(REPO_ROOT)}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
