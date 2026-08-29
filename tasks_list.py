from dataclasses import dataclass
from datetime import date, datetime, timedelta
from zoneinfo import ZoneInfo


NOTION_API_VERSION = "2025-09-03"
TASKS_USAGE = "Usage: /tasks list"
TASKS_CHANNEL_REFUSAL = "The /tasks command is not available in this channel."
NO_TASKS_MESSAGE = "No tasks need attention right now."
MORE_TASKS_MESSAGE = "More tasks may need attention."
MAX_SCANNED_TASKS = 500
MAX_DISPLAYED_TASKS = 20
NOTION_PAGE_SIZE = 100
MAX_NOTION_PAGES = MAX_SCANNED_TASKS // NOTION_PAGE_SIZE
PRIORITY_ORDER = {"High": 0, "Medium": 1, "Low": 2}
STATUS_DONE = "F\u00e6rdig"


@dataclass(frozen=True)
class Task:
    name: str
    url: str
    status: str | None
    follow_up: date | None
    priority: str | None


def handle_tasks_command(
    command,
    text,
    channel_id,
    post_slack_message,
    notion_post,
    environment,
    today=None,
    post_ephemeral_response=None,
):
    """Handle the owned /tasks command family without using Gemini.

    Returning True means the command was fully handled and must not continue
    into the Gemini conversation path. False is reserved for other command
    families. ``today`` is injectable so date-based command behavior can be
    verified without relying on the runner clock.
    """
    if command != "/tasks":
        return False

    if text.strip().casefold() != "list":
        post_task_validation_response(
            TASKS_USAGE, post_slack_message, post_ephemeral_response
        )
        return True

    allowed_channel_id = environment["TASKS_SLACK_CHANNEL_ID"]
    if channel_id != allowed_channel_id:
        # Authorization happens before Notion credentials are read or a
        # Notion request is constructed.
        post_task_validation_response(
            TASKS_CHANNEL_REFUSAL, post_slack_message, post_ephemeral_response
        )
        return True

    command_today = today or copenhagen_today()
    pages, has_unexamined_tasks = fetch_tasks(
        notion_post,
        environment["NOTION_API_KEY"],
        environment["NOTION_TASKS_DATA_SOURCE_ID"],
    )
    eligible_tasks = select_tasks_needing_attention(pages, command_today)

    root_message = post_slack_message("/tasks list")
    if eligible_tasks:
        message = format_task_list(eligible_tasks, command_today)
        if has_unexamined_tasks:
            message = f"{message}\n\n{MORE_TASKS_MESSAGE}"
    elif has_unexamined_tasks:
        # The bounded result is not complete, so the normal empty-state claim
        # would be misleading.
        message = MORE_TASKS_MESSAGE
    else:
        message = NO_TASKS_MESSAGE

    post_slack_message(message, thread_ts=root_message["ts"])
    return True


def post_task_validation_response(message, post_slack_message, post_ephemeral_response):
    if post_ephemeral_response:
        post_ephemeral_response(message)
    else:
        post_slack_message(message)


def fetch_tasks(notion_post, api_key, data_source_id):
    """Fetch at most 500 non-finished task records from Notion.

    A true second result means Notion had another page after the examined set;
    that page is deliberately not fetched.
    """
    results = []
    cursor = None
    has_unexamined_tasks = False

    pages_fetched = 0
    while (
        len(results) < MAX_SCANNED_TASKS
        and pages_fetched < MAX_NOTION_PAGES
    ):
        request_json = {
            "page_size": min(NOTION_PAGE_SIZE, MAX_SCANNED_TASKS - len(results)),
            "filter": {
                "property": "Status",
                "status": {"does_not_equal": STATUS_DONE},
            },
        }
        if cursor:
            request_json["start_cursor"] = cursor

        response = notion_post(
            f"https://api.notion.com/v1/data_sources/{data_source_id}/query",
            headers={
                "Authorization": f"Bearer {api_key}",
                "Content-Type": "application/json",
                "Notion-Version": NOTION_API_VERSION,
            },
            json=request_json,
            timeout=10,
        )
        response.raise_for_status()
        pages_fetched += 1
        response_body = response.json()
        page_results = response_body.get("results", [])
        remaining = MAX_SCANNED_TASKS - len(results)
        results.extend(page_results[:remaining])

        if len(page_results) > remaining:
            has_unexamined_tasks = True
            break
        if not response_body.get("has_more"):
            break

        cursor = response_body.get("next_cursor")
        if not cursor:
            # Do not issue an unsafe repeated request on a malformed pagination
            # response. It cannot be claimed complete.
            has_unexamined_tasks = True
            break
        if (
            len(results) == MAX_SCANNED_TASKS
            or pages_fetched == MAX_NOTION_PAGES
        ):
            has_unexamined_tasks = True
            break

    return results, has_unexamined_tasks


def select_tasks_needing_attention(pages, today):
    tasks = [task_from_notion_page(page) for page in pages]
    eligible_tasks = [task for task in tasks if needs_attention(task, today)]
    return sorted(eligible_tasks, key=task_sort_key)[:MAX_DISPLAYED_TASKS]


def task_from_notion_page(page):
    properties = page["properties"]
    title_property = find_property(properties, "Name", "title")
    name = "".join(
        part.get("plain_text", "") for part in title_property.get("title", [])
    ).strip()
    url = page["url"]
    if not name or not url:
        raise RuntimeError("A task is missing its Name or URL")

    status_property = find_property(properties, "Status", "status")
    status = (status_property.get("status") or {}).get("name")
    priority_property = find_property(properties, "Priority", "select", required=False)
    priority = (
        (priority_property.get("select") or {}).get("name")
        if priority_property
        else None
    )
    follow_up_property = find_property(properties, "Follow-up", "date", required=False)
    follow_up_start = (
        (follow_up_property.get("date") or {}).get("start")
        if follow_up_property
        else None
    )
    return Task(
        name=name,
        url=url,
        status=status,
        follow_up=date.fromisoformat(follow_up_start) if follow_up_start else None,
        priority=priority,
    )


def find_property(properties, display_name, property_type, required=True):
    property_value = properties.get(display_name)
    if property_value and (
        property_value.get("type") == property_type
        or property_type in property_value
    ):
        return property_value

    for candidate in properties.values():
        if candidate.get("type") == property_type or property_type in candidate:
            return candidate
        if property_type == "title" and candidate.get("id") == "title":
            return candidate

    if required:
        raise RuntimeError(f"A task is missing its {display_name} property")
    return None


def copenhagen_today():
    return datetime.now(ZoneInfo("Europe/Copenhagen")).date()


def needs_attention(task, today):
    return task.status != STATUS_DONE and (
        task.follow_up is None or task.follow_up <= today + timedelta(days=7)
    )


def task_sort_key(task):
    priority_rank = PRIORITY_ORDER.get(task.priority, len(PRIORITY_ORDER))
    name_key = task.name.casefold()
    if task.follow_up is None:
        return (1, date.max, priority_rank, name_key)
    return (0, task.follow_up, priority_rank, name_key)


def format_task_list(tasks, today):
    return "\n".join(format_task(task, today) for task in tasks)


def format_task(task, today):
    priority = task.priority or "No priority"
    if task.follow_up is None:
        follow_up = "No follow-up"
    elif task.follow_up < today:
        follow_up = f"Overdue: {task.follow_up.isoformat()}"
    elif task.follow_up == today:
        follow_up = "Follow-up: today"
    else:
        follow_up = f"Follow-up: {task.follow_up.isoformat()}"

    # Track resolution is explicitly deferred. Keep the output honest rather
    # than attempting an additional Notion lookup in this issue.
    return (
        f"• <{task.url}|{task.name}> — Priority: {priority} — "
        f"Track: unavailable — {follow_up}"
    )
