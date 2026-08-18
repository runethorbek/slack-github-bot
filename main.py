import os
import requests

text = os.environ.get("SLACK_TEXT", "")
response_url = os.environ.get("SLACK_RESPONSE_URL", "")

print(f"Modtog fra Slack: {text}")

if not response_url:
    raise Exception("SLACK_RESPONSE_URL mangler")

response = requests.post(
    response_url,
    json={
        "text": f"Læst: {text}"
    },
    timeout=10
)

response.raise_for_status()

print("Svar sendt tilbage til Slack")
