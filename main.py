import os
import sys
import requests
from google import genai

from tasks_list import handle_tasks_command


# ---------------------------------------------------------
# Environment
# ---------------------------------------------------------

text = os.environ["SLACK_TEXT"]
command = os.environ.get("SLACK_COMMAND", "")
channel_id = os.environ["SLACK_CHANNEL_ID"]
slack_token = os.environ["SLACK_BOT_TOKEN"]

event_type = os.environ.get("SLACK_EVENT_TYPE", "slash_command")
thread_ts = os.environ.get("SLACK_THREAD_TS", "")


# ---------------------------------------------------------
# Slack helpers
# ---------------------------------------------------------

def slack_post(method, payload):
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

    result = response.json()

    if not result.get("ok"):
        raise Exception(f"Slack error: {result}")

    return result


def post_slack_message(message, thread_ts=None):
    payload = {
        "channel": channel_id,
        "text": message,
        "mrkdwn": True,
    }

    if thread_ts:
        payload["thread_ts"] = thread_ts

    return slack_post("chat.postMessage", payload)


def get_thread_messages(thread_ts):
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

    result = response.json()

    if not result.get("ok"):
        raise Exception(f"Slack error: {result}")

    return result["messages"]


# ---------------------------------------------------------
# /tasks command family
# ---------------------------------------------------------

if handle_tasks_command(
    command,
    text,
    channel_id,
    post_slack_message,
    requests.post,
    os.environ,
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

conversation = build_conversation(messages)


# Useful while developing.
print("=== SLACK THREAD ===")
print(conversation)
print("====================")


# ---------------------------------------------------------
# Gemini
# ---------------------------------------------------------

client = genai.Client()

prompt = f"""
{SYSTEM_INSTRUCTION}

SLACK THREAD HISTORY:

{conversation}
"""

response = client.interactions.create(
    model="gemini-3.5-flash-lite",
    input=prompt,
)

answer = response.output_text.strip()


# ---------------------------------------------------------
# Reply in the same Slack thread
# ---------------------------------------------------------

post_slack_message(
    answer,
    thread_ts=thread_ts,
)

print("Gemini response posted to Slack thread")
