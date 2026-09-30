"""Outreach e-mail from Team Magpie on behalf of a user: Vercel relay (production) -> Gmail SMTP (local) -> simulated."""
import asyncio
import re
import smtplib
import ssl
from email.message import EmailMessage
from email.utils import formataddr, make_msgid
from typing import Any, Optional, Tuple

import httpx

from app.config import settings

FROM_NAME = "Team Magpie"
DEFAULT_SUBJECT = "{sender} is looking for {looking_for}"
DEFAULT_BODY = ("Hi {name},\n\n"
                "This is Team Magpie. {sender} is looking for {looking_for} and would love to connect with you.\n\n"
                "You can reach {sender} directly at {sender_email}, or simply reply to this e-mail.\n\n"
                "Best regards,\nTeam Magpie")

# Placeholder -> value used when the real value is missing.
PLACEHOLDERS = {"name": "there", "company": "your team", "role": "this", "sender": "a Magpie user",
                "sender_email": "the reply-to address of this e-mail", "looking_for": "someone with your skills"}


def render_template(template: Optional[str], **values: Any) -> str:
    """Plain placeholder substitution (no str.format, so braces in user text are safe)."""
    text = template or ""
    for key, fallback in PLACEHOLDERS.items():
        text = text.replace("{" + key + "}", str(values.get(key) or fallback))
    return text


def with_footer(body: str, sender_name: str) -> str:
    return (f"{body.rstrip()}\n\n--\nSent by Magpie on behalf of {sender_name}, who found your publicly listed details. "
            "Not interested? Just reply \"unsubscribe\".")


def _header_safe(value: str, limit: int) -> str:
    return re.sub(r"[\r\n\"<>]+", " ", value or "").strip()[:limit]


async def deliver(to: str, subject: str, body: str, reply_to: str) -> Tuple[str, Optional[str], Optional[str]]:
    """Returns (status, message_id, error) with status in sent | simulated | failed. Replies go to the user."""
    subject = " ".join(subject.split())[:300]
    from_name = _header_safe(FROM_NAME, 80)
    mode = settings.email_mode
    if mode == "relay":
        try:
            async with httpx.AsyncClient(timeout=30) as client:
                res = await client.post(settings.EMAIL_RELAY_URL,
                                        headers={"x-relay-secret": settings.EMAIL_RELAY_SECRET},
                                        json={"to": to, "subject": subject, "text": body, "replyTo": reply_to,
                                              "fromName": from_name})
            data = res.json() if res.headers.get("content-type", "").startswith("application/json") else {}
            if res.status_code == 200 and data.get("ok"):
                return "sent", data.get("messageId"), None
            return "failed", None, f"Relay HTTP {res.status_code}: {data.get('error') or res.text[:200]}"
        except httpx.HTTPError as exc:
            return "failed", None, f"Relay unreachable: {exc.__class__.__name__}"
    if mode == "direct":
        try:
            message_id = await asyncio.to_thread(_send_gmail, to, subject, body, from_name, reply_to)
            return "sent", message_id, None
        except Exception as exc:
            return "failed", None, f"{exc.__class__.__name__}: {exc}"[:500]
    return "simulated", None, "E-mail sending is not configured, so nothing was delivered."


def _send_gmail(to: str, subject: str, body: str, from_name: str, reply_to: str) -> str:
    msg = EmailMessage()
    msg["From"] = formataddr((from_name, settings.GMAIL_USER))
    msg["To"] = to
    msg["Subject"] = subject
    if reply_to:
        msg["Reply-To"] = reply_to
    message_id = make_msgid(domain="magpie.local")
    msg["Message-ID"] = message_id
    msg.set_content(body)
    with smtplib.SMTP_SSL("smtp.gmail.com", 465, context=ssl.create_default_context(), timeout=30) as smtp:
        smtp.login(settings.GMAIL_USER, settings.GMAIL_APP_PASSWORD)
        smtp.send_message(msg)
    return message_id
