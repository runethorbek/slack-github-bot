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


# 1. Opret en rigtig Slack-besked
root_message = post_slack_message(
    f"💬 {text}"
)

# 2. Gem timestampet på root-beskeden
thread_ts = root_message["ts"]


# 3. Spørg Gemini
client = genai.Client()

response = client.interactions.create(
    model="gemini-3.5-flash-lite",
    input=text,
)

answer = response.output_text


# 4. Svar i tråden
post_slack_message(
    answer,
    thread_ts=thread_ts,
)

print("Gemini-svar sendt i Slack-thread")
