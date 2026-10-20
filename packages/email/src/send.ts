import { render } from "@react-email/render";
import nodemailer, { type Transporter } from "nodemailer";
import type { ReactElement } from "react";
import { log } from "@tuti/shared";

/** SMTP from SMTP_HOST, SMTP_PORT (default 587; 465 means TLS from the start), SMTP_USERNAME, SMTP_PASSWORD. */
function smtp(): Transporter {
  const port = Number(process.env.SMTP_PORT || 587);
  return nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port,
    secure: port === 465,
    auth: process.env.SMTP_USERNAME
      ? { user: process.env.SMTP_USERNAME, pass: process.env.SMTP_PASSWORD }
      : undefined,
  });
}

/** Whether emails really go out (without SMTP_HOST they're only logged). */
export const emailConfigured = () => !!process.env.SMTP_HOST;

/**
 * Sends an email built from a React Email template. Without SMTP_HOST (local
 * development, installs without email) it's written to the log instead.
 * `replyTo` is where replies go (e.g. the person who sent an invite); `headers` are
 * extra headers (e.g. List-Unsubscribe).
 */
export async function sendEmail({
  to,
  subject,
  body,
  replyTo,
  headers,
}: {
  to: string;
  subject: string;
  body: ReactElement;
  replyTo?: string;
  headers?: Record<string, string>;
}) {
  const [html, text] = await Promise.all([render(body), render(body, { plainText: true })]);
  if (!emailConfigured()) {
    log.info("Email not sent: SMTP_HOST is not set", { to, subject, text });
    return;
  }
  // The sender must be an address the SMTP provider lets this install use, so there's no default.
  const from = process.env.EMAIL_FROM;
  if (!from) {
    throw new Error('EMAIL_FROM is not set (e.g. "Acme Feedback <feedback@example.com>")');
  }
  await smtp().sendMail({ from, to, subject, html, text, replyTo, headers });
}
