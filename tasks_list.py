NOTION_API_VERSION = "2025-09-03"


def is_tasks_list_command(command, text):
    return command == "/tasks" and text == "list"


def fetch_one_task(notion_post, api_key, data_source_id):
    response = notion_post(
        f"https://api.notion.com/v1/data_sources/{data_source_id}/query",
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
            "Notion-Version": NOTION_API_VERSION,
        },
        params={"filter_properties[]": "Name"},
        json={"page_size": 1},
        timeout=10,
    )
    response.raise_for_status()

    results = response.json().get("results", [])
    if not results:
        raise RuntimeError("The staging Tasks data source returned no tasks")

    page = results[0]
    title_parts = page["properties"]["Name"]["title"]
    name = "".join(part["plain_text"] for part in title_parts).strip()
    url = page["url"]

    if not name or not url:
        raise RuntimeError("The staging task is missing its Name or URL")

    return name, url


def handle_tasks_list(
    channel_id,
    post_slack_message,
    notion_post,
    environment,
):
    allowed_channel_id = environment["TASKS_SLACK_CHANNEL_ID"]

    # Authorization must happen before Notion credentials are read or a
    # Notion request is constructed.
    if channel_id != allowed_channel_id:
        return False

    name, url = fetch_one_task(
        notion_post,
        environment["NOTION_API_KEY"],
        environment["NOTION_TASKS_DATA_SOURCE_ID"],
    )

    root_message = post_slack_message("/tasks list")
    post_slack_message(f"<{url}|{name}>", thread_ts=root_message["ts"])
    return True
