import os
import requests
from google import genai


text = os.environ["SLACK_TEXT"]
response_url = os.environ["SLACK_RESPONSE_URL"]


# Gemini
client = genai.Client()

response = client.interactions.create(
    model="gemini-3.7-flash",
    input=text,
)

answer = response.output_text

print("Gemini svarede")


# Slack
slack_response = requests.post(
    response_url,
    json={
        "text": answer
    },
    timeout=10,
)

slack_response.raise_for_status()

print("Svar sendt tilbage til Slack")
