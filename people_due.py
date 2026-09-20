from calendar import monthrange
from dataclasses import dataclass
from datetime import date, datetime
import time

from tasks_list import (
    TaskListCommandError,
    call_notion_with_retries,
    copenhagen_today,
    notion_headers,
)


PEOPLE_USAGE = "Usage: /people due"
NO_DUE_PERSON_MESSAGE = "No people are due for contact."
PEOPLE_FAILURE_MESSAGE = "Unable to retrieve people right now. Please try again later."
CADENCE_MONTHS = {
    "1 month": 1,
    "2 months": 2,
    "3 months": 3,
    "6 months": 6,
    "12 months": 12,
}
PEOPLE_PAGE_SIZE = 100
INTERACTIONS_PAGE_SIZE = 1


@dataclass(frozen=True)
class Person:
    page_id: str
    name: str
    cadence: str


@dataclass(frozen=True)
class DuePerson:
    person: Person
    latest_interaction: date | None
    next_contact_due: date | None


class PeopleDueCommandError(Exception):
    """A People cadence failure that is safe to expose generically."""


def handle_people_command(
    command,
    text,
    post_slack_message,
    notion_post,
    environment,
    today=None,
    post_ephemeral_response=None,
    sleep=time.sleep,
):
    """Handle the read-only /people command family without using Gemini."""
    if command != "/people":
        return False

    if text.strip().casefold() != "due":
        post_validation_response(
            PEOPLE_USAGE, post_slack_message, post_ephemeral_response
        )
        return True

    root_message = post_slack_message("/people due")
    try:
        command_today = today or copenhagen_today()
        due_person = find_one_due_person(
            notion_post,
            environment["NOTION_API_KEY"],
            environment["NOTION_PEOPLE_DATA_SOURCE_ID"],
            environment["NOTION_INTERACTIONS_DATA_SOURCE_ID"],
            command_today,
            sleep,
        )
    except (PeopleDueCommandError, TaskListCommandError):
        post_slack_message(
            PEOPLE_FAILURE_MESSAGE, thread_ts=root_message["ts"]
        )
        return True

    message = format_due_person(due_person) if due_person else NO_DUE_PERSON_MESSAGE
    post_slack_message(message, thread_ts=root_message["ts"])
    return True


def post_validation_response(message, post_slack_message, post_ephemeral_response):
    if post_ephemeral_response:
        post_ephemeral_response(message)
    else:
        post_slack_message(message)


def find_one_due_person(
    notion_post,
    api_key,
    people_data_source_id,
    interactions_data_source_id,
    today,
    sleep,
):
    people_pages = query_data_source(
        notion_post,
        api_key,
        people_data_source_id,
        {
            "page_size": PEOPLE_PAGE_SIZE,
            "filter": {
                "property": "Contact cadence",
                "select": {"is_not_empty": True},
            },
        },
        sleep,
    )

    for page in people_pages:
        person = person_from_notion_page(page)
        if person is None:
            continue

        interaction_pages = query_data_source(
            notion_post,
            api_key,
            interactions_data_source_id,
            {
                # Sorting and filtering in Notion make the first row the latest
                # valid, non-future Interaction for this tracer.
                "page_size": INTERACTIONS_PAGE_SIZE,
                "filter": {
                    "and": [
                        {
                            "property": "People",
                            "relation": {"contains": person.page_id},
                        },
                        {
                            "property": "Date",
                            "date": {"is_not_empty": True},
                        },
                        {
                            "property": "Date",
                            "date": {"on_or_before": today.isoformat()},
                        },
                    ]
                },
                "sorts": [{"property": "Date", "direction": "descending"}],
            },
            sleep,
        )
        latest_interaction = latest_valid_interaction_date(
            interaction_pages, today
        )
        next_contact_due = (
            add_calendar_months(
                latest_interaction, CADENCE_MONTHS[person.cadence]
            )
            if latest_interaction
            else None
        )
        if latest_interaction is None or today >= next_contact_due:
            return DuePerson(person, latest_interaction, next_contact_due)

    return None


def query_data_source(notion_post, api_key, data_source_id, request_json, sleep):
    response = call_notion_with_retries(
        lambda: notion_post(
            f"https://api.notion.com/v1/data_sources/{data_source_id}/query",
            headers=notion_headers(api_key),
            json=request_json,
            timeout=10,
        ),
        sleep,
    )
    try:
        response_body = response.json()
        results = response_body["results"]
        if not isinstance(results, list):
            raise TypeError
        return results
    except (AttributeError, KeyError, TypeError, ValueError) as error:
        raise PeopleDueCommandError() from error


def person_from_notion_page(page):
    try:
        properties = page["properties"]
        name_property = properties["Name"]
        cadence_property = properties["Contact cadence"]
        if name_property.get("type") != "title":
            return None
        if cadence_property.get("type") != "select":
            return None
        name = "".join(
            part.get("plain_text", "")
            for part in name_property.get("title", [])
        ).strip()
        cadence = (cadence_property.get("select") or {}).get("name")
        page_id = page["id"]
        if not name or not page_id or cadence not in CADENCE_MONTHS:
            return None
        return Person(page_id, name, cadence)
    except (AttributeError, KeyError, TypeError):
        return None


def latest_valid_interaction_date(pages, today):
    valid_dates = []
    for page in pages:
        try:
            date_property = page["properties"]["Date"]
            if date_property.get("type") != "date":
                continue
            start = (date_property.get("date") or {}).get("start")
            interaction_date = parse_notion_date(start)
            if interaction_date <= today:
                valid_dates.append(interaction_date)
        except (AttributeError, KeyError, TypeError, ValueError):
            continue
    return max(valid_dates, default=None)


def parse_notion_date(value):
    if not isinstance(value, str) or not value:
        raise ValueError
    try:
        return date.fromisoformat(value)
    except ValueError:
        return datetime.fromisoformat(value.replace("Z", "+00:00")).date()


def add_calendar_months(value, months):
    month_index = value.month - 1 + months
    year = value.year + month_index // 12
    month = month_index % 12 + 1
    day = min(value.day, monthrange(year, month)[1])
    return date(year, month, day)


def format_due_person(due_person):
    lines = [
        f"*{due_person.person.name}*",
        f"Contact cadence: {due_person.person.cadence}",
    ]
    if due_person.latest_interaction is None:
        lines.append("Latest interaction: No previous interaction")
    else:
        lines.extend(
            [
                f"Latest interaction: {due_person.latest_interaction.isoformat()}",
                f"Next contact due: {due_person.next_contact_due.isoformat()}",
            ]
        )
    return "\n".join(lines)
