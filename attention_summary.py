"""Scheduled attention summary sent as a private Slack DM.

Reuses the exact /tasks list eligibility and /people due cadence logic so the
summary matches those commands on the same day. Fully deterministic: no
Gemini call is involved. Only counts and safe error descriptions are logged;
Task and People content goes to Slack only.
"""

from dataclasses import dataclass
import os
import sys
import time

import requests

from people_due import (
    INCOMPLETE_SCAN_MESSAGE,
    PeopleDueCommandError,
    find_due_people,
    format_person_name,
)
from tasks_list import (
    MORE_TASKS_MESSAGE,
    NotionAuthenticationError,
    TaskListCommandError,
    copenhagen_today,
    external_error_status_code,
    fetch_tasks,
    format_follow_up,
    select_all_tasks_needing_attention,
)


SUMMARY_HEADER = "*Attention summary*"
TASKS_UNAVAILABLE_MESSAGE = "Tasks unavailable right now."
PEOPLE_UNAVAILABLE_MESSAGE = "People unavailable right now."
MAX_SUMMARY_ITEMS = 5
CONFIG_NAMES = frozenset(
    {
        "NOTION_API_KEY",
        "NOTION_TASKS_DATA_SOURCE_ID",
        "NOTION_PEOPLE_DATA_SOURCE_ID",
        "NOTION_INTERACTIONS_DATA_SOURCE_ID",
    }
)


@dataclass(frozen=True)
class TasksAttention:
    dated_tasks: list
    undated_task_count: int
    is_incomplete: bool
    skipped_task_count: int = 0


@dataclass(frozen=True)
class PeopleAttention:
    due_people: list
    is_incomplete: bool
    skipped_person_count: int = 0


class AttentionSummaryError(RuntimeError):
    """A source failed, so the run must fail; the message is secret-free."""


class SlackDmDeliveryError(RuntimeError):
    """The summary DM could not be posted; the message is secret-free."""


def fetch_tasks_attention(notion_post, environment, today, sleep=time.sleep):
    pages, has_unexamined_tasks = fetch_tasks(
        notion_post,
        environment["NOTION_API_KEY"],
        environment["NOTION_TASKS_DATA_SOURCE_ID"],
        sleep=sleep,
    )
    eligible_tasks, skipped_task_count = select_all_tasks_needing_attention(
        pages, today
    )
    dated_tasks = [task for task in eligible_tasks if task.follow_up is not None]
    return TasksAttention(
        dated_tasks,
        len(eligible_tasks) - len(dated_tasks),
        has_unexamined_tasks,
        skipped_task_count,
    )


def fetch_people_attention(notion_post, environment, today, sleep=time.sleep):
    due_people, is_incomplete, skipped_person_count = find_due_people(
        notion_post,
        environment["NOTION_API_KEY"],
        environment["NOTION_PEOPLE_DATA_SOURCE_ID"],
        environment["NOTION_INTERACTIONS_DATA_SOURCE_ID"],
        today,
        sleep,
    )
    return PeopleAttention(due_people, is_incomplete, skipped_person_count)


def has_tasks_needing_attention(tasks):
    # An incomplete scan is reported like /tasks list does: more tasks may
    # need attention even when none were found. Skipped rows alone are not.
    return tasks is not None and bool(
        tasks.dated_tasks or tasks.undated_task_count or tasks.is_incomplete
    )


def has_people_needing_attention(people):
    return people is not None and bool(people.due_people or people.is_incomplete)


def compose_summary(tasks, people, today):
    """Build the DM text, or None when nothing needs attention.

    ``tasks``/``people`` are None when that source failed; a failed source is
    shown as an "unavailable" line only alongside a section that has items.
    """
    has_tasks = has_tasks_needing_attention(tasks)
    has_people = has_people_needing_attention(people)
    if not has_tasks and not has_people:
        return None

    sections = [SUMMARY_HEADER]
    if tasks is None:
        sections.append(TASKS_UNAVAILABLE_MESSAGE)
    elif has_tasks:
        sections.append(format_tasks_section(tasks, today))

    if people is None:
        sections.append(PEOPLE_UNAVAILABLE_MESSAGE)
    elif has_people:
        sections.append(format_people_section(people))

    return "\n\n".join(sections)


def format_tasks_section(tasks, today):
    lines = ["*Tasks*"]
    displayed = tasks.dated_tasks[:MAX_SUMMARY_ITEMS]
    for task in displayed:
        priority = task.priority or "No priority"
        lines.append(
            f"• <{task.url}|{task.name}> — Priority: {priority} — "
            f"{format_follow_up(task, today)}"
        )
    remainder = len(tasks.dated_tasks) - len(displayed)
    if remainder > 0:
        lines.append(f"+{remainder} more — run /tasks list")
    if tasks.undated_task_count:
        noun = "task" if tasks.undated_task_count == 1 else "tasks"
        lines.append(
            f"{tasks.undated_task_count} open {noun} without follow-up date"
        )
    if tasks.is_incomplete:
        lines.append(MORE_TASKS_MESSAGE)
    if tasks.skipped_task_count:
        noun = "task" if tasks.skipped_task_count == 1 else "tasks"
        lines.append(f"Skipped {tasks.skipped_task_count} malformed {noun}.")
    return "\n".join(lines)


def format_people_section(people):
    lines = ["*People due*"]
    displayed = people.due_people[:MAX_SUMMARY_ITEMS]
    for due_person in displayed:
        if due_person.next_contact_due is None:
            due_text = "No previous interaction"
        else:
            due_text = f"Next contact due: {due_person.next_contact_due.isoformat()}"
        lines.append(f"• {format_person_name(due_person.person)} — {due_text}")
    remainder = len(people.due_people) - len(displayed)
    if remainder > 0:
        lines.append(f"+{remainder} more — run /people due")
    if people.is_incomplete:
        lines.append(INCOMPLETE_SCAN_MESSAGE)
    if people.skipped_person_count:
        noun = "person" if people.skipped_person_count == 1 else "people"
        lines.append(f"Skipped {people.skipped_person_count} malformed {noun}.")
    return "\n".join(lines)


def describe_source_error(error):
    """A secret-free, diagnosable description of a source failure."""
    if isinstance(error, NotionAuthenticationError):
        return str(error)
    if isinstance(error, KeyError) and error.args and error.args[0] in CONFIG_NAMES:
        return f"missing configuration {error.args[0]}"
    description = type(error).__name__
    if isinstance(error, (TaskListCommandError, PeopleDueCommandError)):
        # Only the type name and status code; never the cause's message,
        # URL, headers or body.
        status_code = external_error_status_code(error.__cause__)
        if status_code is not None:
            description = f"{description} (HTTP {status_code})"
    return description


def send_attention_summary(
    post_direct_message,
    notion_post,
    environment,
    today=None,
    sleep=time.sleep,
    log=print,
):
    """Send one summary DM when anything needs attention.

    Returns True when a DM was posted. Raises AttentionSummaryError when any
    source failed, after posting whatever the other source could provide, so
    an unwatched scheduled run still fails visibly.
    """
    summary_today = today or copenhagen_today()
    failures = []

    try:
        tasks = fetch_tasks_attention(notion_post, environment, summary_today, sleep)
    except Exception as error:
        tasks = None
        failures.append(f"Tasks unavailable: {describe_source_error(error)}")

    try:
        people = fetch_people_attention(
            notion_post, environment, summary_today, sleep
        )
    except Exception as error:
        people = None
        failures.append(f"People unavailable: {describe_source_error(error)}")

    for failure in failures:
        log(f"::error::{failure}")

    if tasks is None and people is None:
        raise AttentionSummaryError(
            "Tasks and People are both unavailable; no summary sent."
        )

    message = compose_summary(tasks, people, summary_today)
    if message is None:
        log("Nothing needs attention; no DM sent")
    else:
        post_direct_message(message)
        log("Attention summary DM sent")

    if failures:
        failed_source = "Tasks" if tasks is None else "People"
        outcome = "partial summary sent" if message else "no summary sent"
        raise AttentionSummaryError(f"{failed_source} unavailable; {outcome}.")
    return message is not None


# ---------------------------------------------------------
# Slack transport
# ---------------------------------------------------------

def build_slack_dm_poster(slack_token, user_id, slack_post=requests.post):
    """Post to the app's DM with ``user_id`` (chat.postMessage to a user ID)."""

    def post_direct_message(message):
        try:
            response = slack_post(
                "https://slack.com/api/chat.postMessage",
                headers={
                    "Authorization": f"Bearer {slack_token}",
                    "Content-Type": "application/json",
                },
                json={"channel": user_id, "text": message, "mrkdwn": True},
                timeout=10,
            )
            response.raise_for_status()
            result = response.json()
        except Exception as error:
            status_code = getattr(getattr(error, "response", None), "status_code", None)
            if isinstance(status_code, int):
                raise SlackDmDeliveryError(
                    f"Slack DM delivery failed (HTTP {status_code})."
                ) from None
            raise SlackDmDeliveryError(
                f"Slack DM delivery failed ({type(error).__name__})."
            ) from None

        if not isinstance(result, dict) or not result.get("ok"):
            error_code = result.get("error") if isinstance(result, dict) else None
            raise SlackDmDeliveryError(
                f"Slack DM delivery failed ({error_code or 'unknown'})."
            )
        return result

    return post_direct_message


def main():
    slack_token = os.environ.get("SLACK_BOT_TOKEN", "")
    user_id = os.environ.get("AUTHORIZED_SLACK_USER_ID", "")
    if not slack_token or not user_id:
        print("::error::SLACK_BOT_TOKEN and AUTHORIZED_SLACK_USER_ID are required")
        return 1

    try:
        send_attention_summary(
            build_slack_dm_poster(slack_token, user_id, requests.post),
            requests.post,
            os.environ,
        )
    except (AttentionSummaryError, SlackDmDeliveryError) as error:
        print(f"::error::{error}")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
