from calendar import monthrange
from dataclasses import dataclass
from datetime import date, datetime
from enum import Enum
import time

from tasks_list import (
    TaskListCommandError,
    call_notion_with_retries,
    copenhagen_today,
    notion_headers,
)


PEOPLE_USAGE = "Usage: /people due | /people suggest <person>"
PEOPLE_CHANNEL_REFUSAL = "The /people command is not available in this channel."
NO_DUE_PERSON_MESSAGE = "No people are due for contact."
PEOPLE_FAILURE_MESSAGE = "Unable to retrieve people right now. Please try again later."
INCOMPLETE_SCAN_MESSAGE = (
    "Some People or Interactions could not be scanned; results may be incomplete."
)
CADENCE_MONTHS = {
    "1 month": 1,
    "2 months": 2,
    "3 months": 3,
    "6 months": 6,
    "12 months": 12,
}
PEOPLE_PAGE_SIZE = 100
INTERACTIONS_PAGE_SIZE = 100
MAX_DISPLAYED_PEOPLE = 20
MAX_SCANNED_PEOPLE = 500
MAX_SCANNED_INTERACTIONS = 500


class CadenceStatus(str, Enum):
    DUE_WITH_NO_PREVIOUS_INTERACTION = "due_with_no_previous_interaction"
    NOT_DUE = "not_due"
    DUE_TODAY = "due_today"
    OVERDUE = "overdue"


@dataclass(frozen=True)
class Person:
    page_id: str
    name: str
    cadence: str
    linkedin_url: str | None = None


@dataclass(frozen=True)
class CadenceEvaluation:
    status: CadenceStatus
    latest_interaction_date: date | None
    next_due_date: date | None
    is_due: bool


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
    generate_text=None,
    today=None,
    post_ephemeral_response=None,
    sleep=time.sleep,
    notion_get=None,
):
    """Handle the /people command family.

    ``due`` is fully deterministic. ``suggest <person>`` also reads Notion
    deterministically, but drafts its output with Gemini via the injected
    ``generate_text`` callable, keeping Gemini isolated from Notion access
    and from arbitrary side effects. ``notion_get`` is used only to resolve
    Track relation names for ``suggest``'s recap.
    """
    if command != "/people":
        return False

    normalized_text = text.strip()
    lowered_text = normalized_text.casefold()

    if lowered_text == "due":
        handle_people_due(post_slack_message, notion_post, environment, today, sleep)
        return True

    if lowered_text.startswith("suggest"):
        remainder = normalized_text[len("suggest"):]
        person_name = remainder.strip()
        if person_name and remainder[0].isspace():
            # Imported lazily to avoid a circular import: people_suggest
            # depends on shared helpers defined in this module.
            from people_suggest import handle_people_suggest

            handle_people_suggest(
                person_name,
                post_slack_message,
                notion_post,
                generate_text,
                environment,
                today=today,
                sleep=sleep,
                notion_get=notion_get,
            )
            return True

    post_validation_response(
        PEOPLE_USAGE, post_slack_message, post_ephemeral_response
    )
    return True


def handle_people_due(post_slack_message, notion_post, environment, today, sleep):
    root_message = post_slack_message("/people due")
    try:
        command_today = today or copenhagen_today()
        due_people, is_incomplete, skipped_person_count = find_due_people(
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
        return

    if due_people:
        message = format_due_people(due_people)
        blocks = build_due_people_blocks(due_people)
        if is_incomplete:
            message = f"{message}\n\n{INCOMPLETE_SCAN_MESSAGE}"
            blocks.append(plain_section_block(INCOMPLETE_SCAN_MESSAGE))
    elif is_incomplete:
        # The bounded scan is not complete, so the normal empty-state claim
        # would be misleading.
        message = INCOMPLETE_SCAN_MESSAGE
        blocks = None
    else:
        message = NO_DUE_PERSON_MESSAGE
        blocks = None

    if skipped_person_count:
        noun = "person" if skipped_person_count == 1 else "people"
        skipped_message = f"Skipped {skipped_person_count} malformed {noun}."
        message = f"{message}\n\n{skipped_message}"
        if blocks:
            blocks.append(plain_section_block(skipped_message))

    post_slack_message(message, thread_ts=root_message["ts"], blocks=blocks)


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
    """Legacy Slice 1 single-Person finder.

    Superseded by find_due_people for the /people due command; kept only
    because Slice 1/2 tests exercise it directly to pin the original
    per-Person query behavior. Do not build new behavior on this path.
    """
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
        evaluation = evaluate_cadence(
            person.cadence,
            interaction_date_values(interaction_pages),
            today,
        )
        if evaluation.is_due:
            return DuePerson(
                person,
                evaluation.latest_interaction_date,
                evaluation.next_due_date,
            )

    return None


def find_due_people(
    notion_post,
    api_key,
    people_data_source_id,
    interactions_data_source_id,
    today,
    sleep,
):
    """Evaluate every cadenced Person and return those who are due.

    Interactions are fetched once and grouped locally by related Person,
    instead of issuing one Notion query per Person. Returns
    (due_people, is_incomplete, skipped_person_count); is_incomplete is
    True when the bounded scan of People or Interactions could not read
    everything, so the result must not be presented as a complete or
    empty listing. skipped_person_count counts individually malformed
    People records that were skipped rather than crashing the command.
    """
    people_pages, has_unexamined_people = fetch_people_pages(
        notion_post, api_key, people_data_source_id, sleep
    )
    interaction_dates_by_person, has_unexamined_interactions = (
        fetch_interaction_dates_by_person(
            notion_post, api_key, interactions_data_source_id, today, sleep
        )
    )

    due_people = []
    skipped_person_count = 0
    for page in people_pages:
        person = person_from_notion_page(page)
        if person is None:
            skipped_person_count += 1
            continue

        evaluation = evaluate_cadence(
            person.cadence,
            interaction_dates_by_person.get(person.page_id, []),
            today,
        )
        if evaluation.is_due:
            due_people.append(
                DuePerson(
                    person,
                    evaluation.latest_interaction_date,
                    evaluation.next_due_date,
                )
            )

    due_people.sort(key=due_person_sort_key)
    is_incomplete = has_unexamined_people or has_unexamined_interactions
    return due_people, is_incomplete, skipped_person_count


def due_person_sort_key(due_person):
    name_key = due_person.person.name.casefold()
    if due_person.next_contact_due is not None:
        return (0, due_person.next_contact_due, name_key)
    return (1, date.max, name_key)


def fetch_people_pages(notion_post, api_key, people_data_source_id, sleep):
    """Fetch every Person with a configured Contact cadence, bounded."""

    def build_request_json(cursor):
        request_json = {
            "page_size": PEOPLE_PAGE_SIZE,
            "filter": {
                "property": "Contact cadence",
                "select": {"is_not_empty": True},
            },
        }
        if cursor:
            request_json["start_cursor"] = cursor
        return request_json

    return fetch_notion_pages(
        notion_post,
        api_key,
        people_data_source_id,
        build_request_json,
        MAX_SCANNED_PEOPLE,
        PEOPLE_PAGE_SIZE,
        sleep,
    )


def fetch_interaction_dates_by_person(
    notion_post, api_key, interactions_data_source_id, today, sleep
):
    """Fetch Interactions with a valid Date on or before today, once.

    Results are grouped by related Person page id so cadence can be
    evaluated for every Person without a per-Person Notion query.
    """

    def build_request_json(cursor):
        request_json = {
            "page_size": INTERACTIONS_PAGE_SIZE,
            "filter": {
                "and": [
                    {"property": "Date", "date": {"is_not_empty": True}},
                    {
                        "property": "Date",
                        "date": {"on_or_before": today.isoformat()},
                    },
                ]
            },
            "sorts": [{"property": "Date", "direction": "descending"}],
        }
        if cursor:
            request_json["start_cursor"] = cursor
        return request_json

    pages, has_unexamined_interactions = fetch_notion_pages(
        notion_post,
        api_key,
        interactions_data_source_id,
        build_request_json,
        MAX_SCANNED_INTERACTIONS,
        INTERACTIONS_PAGE_SIZE,
        sleep,
    )

    dates_by_person = {}
    for page in pages:
        for person_id, date_value in interaction_person_dates(page):
            dates_by_person.setdefault(person_id, []).append(date_value)

    return dates_by_person, has_unexamined_interactions


def fetch_notion_pages(
    notion_post, api_key, data_source_id, build_request_json, max_scanned, page_size, sleep
):
    """Query a Notion data source across pages, bounded by max_scanned.

    Returns (pages, is_incomplete); is_incomplete is True when the bound
    was reached, or pagination could not safely continue, before every
    matching page was read.
    """
    results = []
    cursor = None
    pages_fetched = 0
    max_pages = max_scanned // page_size

    while True:
        response = call_notion_with_retries(
            lambda: notion_post(
                f"https://api.notion.com/v1/data_sources/{data_source_id}/query",
                headers=notion_headers(api_key),
                json=build_request_json(cursor),
                timeout=10,
            ),
            sleep,
        )
        pages_fetched += 1
        try:
            response_body = response.json()
            page_results = response_body["results"]
            if not isinstance(page_results, list):
                raise TypeError
        except (AttributeError, KeyError, TypeError, ValueError) as error:
            raise PeopleDueCommandError() from error

        results.extend(page_results)

        if not response_body.get("has_more"):
            return results, False

        cursor = response_body.get("next_cursor")
        if not cursor or pages_fetched == max_pages:
            return results, True


def interaction_person_dates(page):
    try:
        properties = page["properties"]
        date_property = properties["Date"]
        if date_property.get("type") != "date":
            return []
        date_value = (date_property.get("date") or {}).get("start")

        people_property = properties.get("People")
        if not people_property or people_property.get("type") != "relation":
            return []
        person_ids = [
            relation["id"]
            for relation in people_property.get("relation", [])
            if relation.get("id")
        ]
        return [(person_id, date_value) for person_id in person_ids]
    except (AttributeError, KeyError, TypeError):
        return []


def format_due_people(due_people):
    displayed = due_people[:MAX_DISPLAYED_PEOPLE]
    message = "\n\n".join(format_due_person(due_person) for due_person in displayed)

    remainder = len(due_people) - len(displayed)
    if remainder > 0:
        message = f"{message}\n\n+{remainder} more"
    return message


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
        linkedin_url = extract_linkedin_url(properties)
        return Person(page_id, name, cadence, linkedin_url)
    except (AttributeError, KeyError, TypeError):
        return None


def extract_linkedin_url(properties):
    """Read the LinkedIn URL property as-is; never construct or guess one."""
    linkedin_property = properties.get("LinkedIn")
    if not isinstance(linkedin_property, dict):
        return None
    if linkedin_property.get("type") != "url":
        return None
    url = linkedin_property.get("url")
    return url if isinstance(url, str) and url else None


def interaction_date_values(pages):
    values = []
    for page in pages:
        try:
            date_property = page["properties"]["Date"]
            if date_property.get("type") != "date":
                continue
            values.append((date_property.get("date") or {}).get("start"))
        except (AttributeError, KeyError, TypeError):
            continue
    return values


def latest_valid_interaction_date(values, today):
    valid_dates = []
    for value in values:
        try:
            interaction_date = parse_notion_date(value)
            if interaction_date <= today:
                valid_dates.append(interaction_date)
        except (TypeError, ValueError):
            continue
    return max(valid_dates, default=None)


def evaluate_cadence(cadence, interaction_dates, today):
    """Evaluate one person's cadence from raw Interaction date values."""
    months = CADENCE_MONTHS[cadence]
    latest_interaction = latest_valid_interaction_date(interaction_dates, today)
    if latest_interaction is None:
        return CadenceEvaluation(
            CadenceStatus.DUE_WITH_NO_PREVIOUS_INTERACTION,
            None,
            None,
            True,
        )

    next_due_date = add_calendar_months(latest_interaction, months)
    if today < next_due_date:
        status = CadenceStatus.NOT_DUE
        is_due = False
    elif today == next_due_date:
        status = CadenceStatus.DUE_TODAY
        is_due = True
    else:
        status = CadenceStatus.OVERDUE
        is_due = True
    return CadenceEvaluation(status, latest_interaction, next_due_date, is_due)


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


def format_person_name(person):
    if person.linkedin_url:
        return f"<{person.linkedin_url}|{person.name}>"
    return person.name


def format_due_person(due_person):
    lines = [
        f"*{format_person_name(due_person.person)}*",
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


PEOPLE_SUGGEST_ACTION_ID = "people_suggest"


def suggest_button(person):
    """A Block Kit button that, on click, invokes /people suggest <name>.

    The button's value is the Person's exact Name, so a click is handled by
    api/slack-request.js and main.py exactly like a typed
    `/people suggest <person>` command - same Person resolution, same
    Gemini prompting, no duplicated logic.
    """
    return {
        "type": "button",
        "text": {"type": "plain_text", "text": "Suggest message"},
        "action_id": PEOPLE_SUGGEST_ACTION_ID,
        "value": person.name,
    }


def due_person_block(due_person):
    return {
        "type": "section",
        "text": {"type": "mrkdwn", "text": format_due_person(due_person)},
        "accessory": suggest_button(due_person.person),
    }


def plain_section_block(text):
    return {"type": "section", "text": {"type": "mrkdwn", "text": text}}


def build_due_people_blocks(due_people):
    displayed = due_people[:MAX_DISPLAYED_PEOPLE]
    blocks = [due_person_block(due_person) for due_person in displayed]

    remainder = len(due_people) - len(displayed)
    if remainder > 0:
        blocks.append(plain_section_block(f"+{remainder} more"))
    return blocks
