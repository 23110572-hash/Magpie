// Vercel Serverless Function: POST /api/send-email
// Render blocks SMTP ports, so the backend relays outreach e-mails here over HTTPS.
// Env vars (Vercel project settings): EMAIL_RELAY_SECRET, GMAIL_USER, GMAIL_APP_PASSWORD
import { timingSafeEqual } from "node:crypto";
import nodemailer from "nodemailer";

const EMAIL_RE = /^[^\s@<>()",;:]+@[^\s@<>()",;:]+\.[A-Za-z]{2,}$/;
let transporter;

function getTransporter() {
  if (!transporter) {
    transporter = nodemailer.createTransport({
      host: "smtp.gmail.com",
      port: 465,
      secure: true,
      auth: {
        user: process.env.GMAIL_USER,
        pass: (process.env.GMAIL_APP_PASSWORD || "").replace(/\s+/g, ""),
      },
    });
  }
  return transporter;
}

function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
}

const oneLine = (value, max) => String(value ?? "").replace(/[\r\n]+/g, " ").trim().slice(0, max);

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ ok: false, error: "Method not allowed" });
  }
  const secret = process.env.EMAIL_RELAY_SECRET || "";
  const supplied = req.headers["x-relay-secret"];
  if (!secret || typeof supplied !== "string" || !safeEqual(supplied, secret)) {
    return res.status(401).json({ ok: false, error: "Unauthorized" });
  }
  if (!process.env.GMAIL_USER || !process.env.GMAIL_APP_PASSWORD) {
    return res.status(500).json({ ok: false, error: "E-mail relay is not configured" });
  }

  let body = req.body;
  if (typeof body === "string") {
    try {
      body = JSON.parse(body);
    } catch {
      body = null;
    }
  }
  const to = oneLine(body?.to, 254);
  const subject = oneLine(body?.subject, 300);
  const text = String(body?.text ?? "").slice(0, 20000);
  const replyTo = oneLine(body?.replyTo, 254);
  const fromName = oneLine(body?.fromName, 80).replace(/["<>]/g, "") || "Magpie";
  if (!EMAIL_RE.test(to) || !subject || !text.trim()) {
    return res.status(400).json({ ok: false, error: "A valid recipient, subject and body are required" });
  }

  try {
    const info = await getTransporter().sendMail({
      from: { name: fromName, address: process.env.GMAIL_USER },
      to,
      subject,
      text,
      replyTo: EMAIL_RE.test(replyTo) ? replyTo : undefined,
    });
    return res.status(200).json({ ok: true, messageId: info.messageId });
  } catch (err) {
    console.error("send-email failed:", err?.code || err?.name || "error");
    return res.status(502).json({ ok: false, error: "The mail server rejected the message" });
  }
}
