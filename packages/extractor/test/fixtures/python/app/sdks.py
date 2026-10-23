import stripe
from openai import OpenAI
from slack_sdk import WebClient
from twilio.rest import Client

openai_client = OpenAI()
slack = WebClient(token="xoxb-test")
twilio = Client("ACxxx", "token")


def checkout_kind(session_id):
    session = stripe.checkout.Session.retrieve(session_id)
    if session.ui_mode == "hosted":
        return "redirect"
    return "in-page"


def ask(prompt):
    completion = openai_client.chat.completions.create(model="gpt-4o-mini", messages=[{"role": "user", "content": prompt}])
    return completion.choices[0].message.content


def upload(channel, path):
    slack.files_upload(channels=channel, file=path)
    slack.chat_postMessage(channel=channel, text="uploaded")
    slack.close()


def text(to, body):
    return twilio.messages.create(to=to, from_="+15005550006", body=body).sid
