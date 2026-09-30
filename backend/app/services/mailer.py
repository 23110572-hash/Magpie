"""Outreach e-mail: Vercel relay (production) -> direct Gmail SMTP (local) -> simulated."""
import asyncio
import re
import smtplib
import ssl
from email.message import EmailMessage
from email.utils import formataddr, make_msgid
from typing import Optional, Tuple

import httpx

from app.config import settings

DEFAULT_SUBJECT = "Quick question for {name}"
DEFAULT_BODY = ("Hi {name},\n\nI came across {company} while researching {role} and would love to connect.\n\n"
                "Would you be open to a short chat this week?\n\nBest regards")


def render_template(template: Optional[str], *, name: Optional[str], company: Optional[str], role: Optional[str]) -> str:
    """Plain placeholder substitution (no str.format, so braces in user text are safe)."""
    text = template or ""
    for key, value in (("{name}", name or "there"), ("{company}", company or "your team"), ("{role}", role or "this")):
        text = text.replace(key, value)
    return text


def _header_safe(value: str, limit: int) -> str:
    return re.sub(r"[\r\n\"<>]+", " ", value or "").strip()[:limit]


def with_footer(body: str, sender_name: str) -> str:
    return (f"{body.rstrip()}\n\n--\nSent by {sender_name} via Magpie. "
            "If you'd rather not hear from me, just reply \"unsubscribe\".")


async def deliver(to: str, subject: str, body: str, sender_name: str, reply_to: str) -> Tuple[str, Optional[str], Optional[str]]:
    """Returns (status, message_id, error) with status in sent | simulated | failed."""
    subject = " ".join(subject.split())[:300]
    from_name = _header_safe(f"{sender_name} via Magpie", 80)
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
