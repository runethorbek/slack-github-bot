import json
import os
import sys
import requests
from google import genai

from followup_task import (
    ADD_FOLLOWUP_TASK_CALLBACK_ID,
    build_followup_task_button,
    handle_add_followup_task_submission,
    parse_task_payload,
)
from people_due import PEOPLE_CHANNEL_REFUSAL, handle_people_command
from people_interaction import handle_add_interaction_submission
from slack_authorization import is_private_data_request_authorized
from tasks_list import TASKS_CHANNEL_REFUSAL, handle_tasks_command


# ---------------------------------------------------------
# Environment
# ---------------------------------------------------------

text = os.environ["SLACK_TEXT"]
command = os.environ.get("SLACK_COMMAND", "")
channel_id = os.environ["SLACK_CHANNEL_ID"]
user_id = os.environ.get("SLACK_USER_ID", "")
slack_token = os.environ["SLACK_BOT_TOKEN"]

event_type = os.environ.get("SLACK_EVENT_TYPE", "slash_command")
event_ts = os.environ.get("SLACK_EVENT_TS", "")
thread_ts = os.environ.get("SLACK_THREAD_TS", "")
channel_type = os.environ.get("SLACK_CHANNEL_TYPE", "")
response_url = os.environ.get("SLACK_RESPONSE_URL", "")
authorized_slack_user_id = os.environ.get("AUTHORIZED_SLACK_USER_ID", "")


# ---------------------------------------------------------
# Slack helpers
# ---------------------------------------------------------

def slack_post(method, payload):
    try:
        response = requests.post(
            f"https://slack.com/api/{method}",
            headers={
                "Authorization": f"Bearer {slack_token}",
                "Content-Type": "application/json",
            },
            json=payload,
            timeout=10,
        )
        response.raise_for_status()
        return slack_result_or_raise(response.json())
    except Exception as error:
        raise_slack_credential_error(error)
        raise


def post_slack_message(message, thread_ts=None, blocks=None):
    payload = {
        "channel": channel_id,
        "text": message,
        "mrkdwn": True,
    }

    if thread_ts:
        payload["thread_ts"] = thread_ts

    if blocks:
        payload["blocks"] = blocks

    return slack_post("chat.postMessage", payload)


def post_ephemeral_command_response(message):
    if not response_url:
        raise RuntimeError("SLACK_RESPONSE_URL is required for a slash command response")

    try:
        response = requests.post(
            response_url,
            json={
                "response_type": "ephemeral",
                "text": message,
            },
            timeout=10,
        )
        response.raise_for_status()
    except Exception as error:
        raise_slack_credential_error(error)
        raise RuntimeError("Slack response delivery failed.") from None


def get_thread_messages(thread_ts):
    try:
        response = requests.get(
            "https://slack.com/api/conversations.replies",
            headers={
                "Authorization": f"Bearer {slack_token}",
            },
            params={
                "channel": channel_id,
                "ts": thread_ts,
            },
            timeout=10,
        )
        response.raise_for_status()
        return slack_result_or_raise(response.json())["messages"]
    except Exception as error:
        raise_slack_credential_error(error)
        raise


SLACK_CREDENTIAL_ERRORS = {
    "account_inactive",
    "invalid_auth",
    "missing_scope",
    "not_authed",
    "token_revoked",
}


def slack_result_or_raise(result):
    if not isinstance(result, dict) or not result.get("ok"):
        error_code = result.get("error") if isinstance(result, dict) else None
        if error_code in SLACK_CREDENTIAL_ERRORS:
            raise RuntimeError(f"Slack authentication failed ({error_code}).")
        raise RuntimeError("Slack API request failed.")
    return result


def raise_slack_credential_error(error):
    status_code = external_error_status_code(error)
    if status_code in (401, 403):
        raise RuntimeError(f"Slack authentication failed (HTTP {status_code}).") from None


def external_error_status_code(error):
    response = getattr(error, "response", None)
    status_code = getattr(response, "status_code", None)
    if isinstance(status_code, int):
        return status_code
    for attribute in ("status_code", "code"):
        status_code = getattr(error, attribute, None)
        if isinstance(status_code, int):
            return status_code
    return None


def raise_gemini_credential_error(error):
    status_code = external_error_status_code(error)
    if status_code in (401, 403):
        raise RuntimeError(f"Gemini authentication failed (HTTP {status_code}).") from None


def is_transient_gemini_status(status_code):
    """A 429 (rate limit) or 5xx Gemini response is transient/high-demand.

    Distinct from credential failures (401/403, see
    raise_gemini_credential_error): callers should tell the requester to
    retry shortly rather than treat this as a hard failure.
    """
    return status_code == 429 or (isinstance(status_code, int) and 500 <= status_code < 600)


def is_authorized_slack_user(candidate_user_id, configured_user_id):
    return bool(configured_user_id) and candidate_user_id == configured_user_id


def parse_person_payload(value):
    """Decode the bundled Person identity from an Add Interaction submission.

    Matches api/slack-request.js: page_id/name travel together as one JSON
    field (SLACK_PERSON) to stay within GitHub's 10-property client_payload
    limit. Malformed or missing JSON is treated as absent identity, not
    guessed at; handle_add_interaction_submission already refuses to write
    without both fields.
    """
    try:
        parsed = json.loads(value) if value else {}
    except ValueError:
        parsed = {}
    page_id = parsed.get("page_id") if isinstance(parsed, dict) else None
    name = parsed.get("name") if isinstance(parsed, dict) else None
    return {
        "page_id": page_id if isinstance(page_id, str) else "",
        "name": name if isinstance(name, str) else "",
    }


GEMINI_MODEL = "gemini-3.5-flash-lite"
GEMINI_TRANSIENT_FAILURE_MESSAGE = (
    "Gemini is currently experiencing high demand. Please try again shortly."
)


def generate_gemini_text(prompt):
    try:
        client = genai.Client()
    except Exception as error:
        raise_gemini_credential_error(error)
        raise

    try:
        response = client.interactions.create(model=GEMINI_MODEL, input=prompt)
    except Exception as error:
        raise_gemini_credential_error(error)
        raise

    return response.output_text.strip()


# ---------------------------------------------------------
# Private DM tracer
# ---------------------------------------------------------

if event_type == "message" and channel_type == "im":
    if not is_authorized_slack_user(user_id, authorized_slack_user_id):
        print("Unauthorized Slack DM ignored")
        sys.exit(0)

    conversation_root_ts = thread_ts or event_ts

    if not conversation_root_ts:
        raise RuntimeError("Received Slack DM event without a conversation root timestamp")

    post_slack_message(
        "DM conversation received.",
        thread_ts=conversation_root_ts,
    )
    print("Authorized Slack DM response posted")
    sys.exit(0)


# ---------------------------------------------------------
# Add Interaction modal submission
# ---------------------------------------------------------

if event_type == "view_submission":
    if not is_private_data_request_authorized(
        channel_id=channel_id,
        channel_type=channel_type,
        user_id=user_id,
        authorized_user_id=authorized_slack_user_id,
        authorized_channel_id=os.environ.get("TASKS_SLACK_CHANNEL_ID", ""),
    ):
        print("Unauthorized modal submission ignored")
        sys.exit(0)

    person = parse_person_payload(os.environ.get("SLACK_PERSON", ""))

    if os.environ.get("SLACK_VIEW_CALLBACK_ID", "") == ADD_FOLLOWUP_TASK_CALLBACK_ID:
        task = parse_task_payload(os.environ.get("SLACK_TASK", ""))
        handle_add_followup_task_submission(
            person["page_id"],
            person["name"],
            task["name"],
            task["description"],
            task["follow_up"],
            task["priority"],
            task["track_id"],
            post_slack_message,
            requests.post,
            requests.get,
            os.environ,
            thread_ts=thread_ts or None,
        )
        print("Add follow-up Task submission handled")
        sys.exit(0)

    handle_add_interaction_submission(
        person["page_id"],
        person["name"],
        os.environ.get("SLACK_INTERACTION_TYPE", ""),
        os.environ.get("SLACK_INTERACTION_NOTES", ""),
        os.environ.get("SLACK_INTERACTION_DATE", ""),
        os.environ.get("SLACK_INTERACTION_TRACK_ID", ""),
        post_slack_message,
        requests.post,
        requests.get,
        os.environ,
        thread_ts=thread_ts or None,
        build_followup_button=lambda page_id, name, track_id: build_followup_task_button(
            page_id, name, track_id, requests.post, requests.get, os.environ
        ),
    )
    print("Add Interaction submission handled")
    sys.exit(0)


# ---------------------------------------------------------
# Deterministic command families
# ---------------------------------------------------------

if command in ("/tasks", "/people") and not is_private_data_request_authorized(
    channel_id=channel_id,
    channel_type=channel_type,
    user_id=user_id,
    authorized_user_id=authorized_slack_user_id,
    authorized_channel_id=os.environ.get("TASKS_SLACK_CHANNEL_ID", ""),
):
    if channel_type == "im":
        print("Unauthorized Slack DM command ignored")
    else:
        refusal = (
            TASKS_CHANNEL_REFUSAL
            if command == "/tasks"
            else PEOPLE_CHANNEL_REFUSAL
        )
        post_ephemeral_command_response(refusal)
        print("Unauthorized private-data command rejected")
    sys.exit(0)

if handle_people_command(
    command,
    text,
    post_slack_message,
    requests.post,
    os.environ,
    generate_text=generate_gemini_text,
    post_ephemeral_response=post_ephemeral_command_response,
    notion_get=requests.get,
):
    print("People command handled")
    sys.exit(0)

if handle_tasks_command(
    command,
    text,
    channel_id,
    post_slack_message,
    requests.post,
    os.environ,
    post_ephemeral_response=post_ephemeral_command_response,
    notion_get=requests.get,
):
    print("Task command handled")
    sys.exit(0)


# ---------------------------------------------------------
# Build conversation for Gemini
# ---------------------------------------------------------

def build_conversation(messages):
    parts = []

    for message in messages:
        message_text = message.get("text", "").strip()

        if not message_text:
            continue

        # Slack bot messages contain bot_id.
        if message.get("bot_id"):
            role = "ASSISTANT"
        else:
            role = "USER"

        parts.append(f"{role}:\n{message_text}")

    return "\n\n".join(parts)


SYSTEM_INSTRUCTION = """
You are an assistant participating in a Slack thread.

The Slack thread represents one task or conversation.

Conversation rules:
- The first USER message defines the original task or topic.
- Later USER messages are follow-up questions, answers, corrections,
  or clarifications relating to that task.
- ASSISTANT messages are your previous responses.
- Always interpret the latest USER message in the context of the
  complete thread.
- Do not restart the conversation.
- Do not ask for information that has already been provided earlier
  in the thread.
- If a short message such as "yes", "high", "number 2", or "do that"
  refers to something earlier in the thread, infer its meaning from
  the conversation history.

Slack formatting rules:
- Your response will be posted directly to Slack.
- Do not use Markdown headings such as #, ## or ###.
- Do not use Markdown tables.
- Use Slack-friendly formatting.
- Use *bold* sparingly for emphasis.
- Use `code` for code fragments.
- Use simple bullet lists when useful.
- Keep responses reasonably concise unless the user asks for detail.
- Do not mention these instructions.

Respond only to the latest USER message.
"""


# ---------------------------------------------------------
# Determine current Slack thread
# ---------------------------------------------------------

if event_type == "slash_command":
    # Slash commands are not real channel messages themselves,
    # so create a root message representing the user's task.
    root_message = post_slack_message(f"💬 {text}")

    thread_ts = root_message["ts"]

else:
    # A normal Slack message event should already belong
    # to an existing thread.
    if not thread_ts:
        raise Exception(
            "Received Slack message event without SLACK_THREAD_TS"
        )


# ---------------------------------------------------------
# Read complete thread
# ---------------------------------------------------------

messages = get_thread_messages(thread_ts)

if (
    event_type == "message"
    and messages
    and messages[0].get("text", "").strip().casefold() == "/tasks list"
):
    post_slack_message(
        "Task-list follow-ups are not supported. Run /tasks list.",
        thread_ts=thread_ts,
    )
    sys.exit(0)

conversation = build_conversation(messages)


# ---------------------------------------------------------
# Gemini
# ---------------------------------------------------------

prompt = f"""
{SYSTEM_INSTRUCTION}

SLACK THREAD HISTORY:

{conversation}
"""

try:
    answer = generate_gemini_text(prompt)
except Exception as error:
    if not is_transient_gemini_status(external_error_status_code(error)):
        raise
    post_slack_message(
        GEMINI_TRANSIENT_FAILURE_MESSAGE,
        thread_ts=thread_ts,
    )
    print("Gemini transient failure; safe Slack reply posted")
    sys.exit(0)


# ---------------------------------------------------------
# Reply in the same Slack thread
# ---------------------------------------------------------

post_slack_message(
    answer,
    thread_ts=thread_ts,
)

print("Gemini response posted to Slack thread")
