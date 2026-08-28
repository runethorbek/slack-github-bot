NOTION_API_VERSION = "2025-09-03"
TASKS_USAGE = "Usage: /tasks list"
TASKS_CHANNEL_REFUSAL = "The /tasks command is not available in this channel."


def handle_tasks_command(
    command,
    text,
    channel_id,
    post_slack_message,
    notion_post,
    environment,
):
    """Handle the owned /tasks command family.

    Returning True means the command was fully handled and must not continue
    into the Gemini conversation path. False is reserved for other command
    families.
    """
    if command != "/tasks":
        return False

    if text.strip().casefold() != "list":
        post_slack_message(TASKS_USAGE)
        return True

    allowed_channel_id = environment["TASKS_SLACK_CHANNEL_ID"]

    # Authorization must happen before Notion credentials are read or a
    # Notion request is constructed.
    if channel_id != allowed_channel_id:
        post_slack_message(TASKS_CHANNEL_REFUSAL)
        return True

    name, url = fetch_one_task(
        notion_post,
        environment["NOTION_API_KEY"],
        environment["NOTION_TASKS_DATA_SOURCE_ID"],
    )

    root_message = post_slack_message("/tasks list")
    post_slack_message(f"<{url}|{name}>", thread_ts=root_message["ts"])
    return True


def fetch_one_task(notion_post, api_key, data_source_id):
    response = notion_post(
        f"https://api.notion.com/v1/data_sources/{data_source_id}/query",
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
            "Notion-Version": NOTION_API_VERSION,
        },
        params={"filter_properties[]": "title"},
        json={"page_size": 1},
        timeout=10,
    )

    response.raise_for_status()

    results = response.json().get("results", [])
    if not results:
        raise RuntimeError("The staging Tasks data source returned no tasks")

    page = results[0]
    title_property = next(
        (
            property_value
            for property_value in page["properties"].values()
            if property_value.get("id") == "title"
        ),
        None,
    )
    if not title_property:
        raise RuntimeError("The staging task is missing its title property")

    title_parts = title_property["title"]
    name = "".join(part["plain_text"] for part in title_parts).strip()
    url = page["url"]

    if not name or not url:
        raise RuntimeError("The staging task is missing its Name or URL")

    return name, url
