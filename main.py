import os
import requests
from google import genai


text = os.environ["SLACK_TEXT"]
channel_id = os.environ["SLACK_CHANNEL_ID"]
slack_token = os.environ["SLACK_BOT_TOKEN"]

event_type = os.environ.get("SLACK_EVENT_TYPE", "slash_command")
thread_ts = os.environ.get("SLACK_THREAD_TS", "")


def slack_request(method, payload):
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
    }

    if thread_ts:
        payload["thread_ts"] = thread_ts

    return slack_request("chat.postMessage", payload)


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


client = genai.Client()


if event_type == "slash_command":

    # Start en NY samtale
    root_message = post_slack_message(f"💬 {text}")

    thread_ts = root_message["ts"]

    conversation = text

else:

    # Fortsæt en EKSISTERENDE Slack-thread
    if not thread_ts:
        raise Exception("Message event mangler thread_ts")

    messages = get_thread_messages(thread_ts)

    print("=== THREAD HISTORY ===")

    conversation_parts = []

    for message in messages:
        message_text = message.get("text", "")

        print(message_text)

        conversation_parts.append(message_text)

    conversation = "\n".join(conversation_parts)


print("=== SENDES TIL GEMINI ===")
print(conversation)


response = client.interactions.create(
    model="gemini-3.5-flash-lite",
    input=conversation,
)

answer = response.output_text


# Svar altid i den relevante thread
post_slack_message(
    answer,
    thread_ts=thread_ts,
)

print("Gemini-svar sendt i Slack-thread")
