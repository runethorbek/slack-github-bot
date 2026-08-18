import os
import requests
from google import genai


text = os.environ["SLACK_TEXT"]
channel_id = os.environ["SLACK_CHANNEL_ID"]
slack_token = os.environ["SLACK_BOT_TOKEN"]


def post_slack_message(text, thread_ts=None):
    payload = {
        "channel": channel_id,
        "text": text,
    }

    if thread_ts:
        payload["thread_ts"] = thread_ts

    response = requests.post(
        "https://slack.com/api/chat.postMessage",
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
