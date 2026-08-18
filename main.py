import os

text = os.environ.get("SLACK_TEXT", "")

print(f"Modtog fra Slack: {text}")
