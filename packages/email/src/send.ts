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
 * extra headers (e.g. List-Unsubscribe); `from` replaces EMAIL_FROM (a project's support
 * address, which the SMTP provider must also let it send from); `fromName` names EMAIL_FROM's sender
 * for what it's about ("Tuti Autopilot"). Returns the SMTP server's answer to the message (with its
 * id there, e.g. Amazon SES's).
 */
export async function sendEmail({
  to,
  subject,
  body,
  replyTo,
  headers,
  from: sender,
  fromName,
  messageId,
  attachments,
}: {
  to: string;
  subject: string;
  body: ReactElement;
  replyTo?: string;
  headers?: Record<string, string>;
  from?: string;
  fromName?: string;
  /** Its Message-ID (`<random@domain>`), when replies to it must be recognised; otherwise one is made. */
  messageId?: string;
  /** Files sent with it, as attachments. */
  attachments?: { filename: string; contentType: string; content: Uint8Array }[];
}): Promise<string | null> {
  const [html, text] = await Promise.all([render(body), render(body, { plainText: true })]);
  if (!emailConfigured()) {
    log.info("Email not sent: SMTP_HOST is not set", { to, subject, text });
    return null;
  }
  // The sender must be an address the SMTP provider lets this install use, so there's no default.
  const from = sender ?? process.env.EMAIL_FROM;
  if (!from) {
    throw new Error('EMAIL_FROM is not set (e.g. "Acme Feedback <feedback@example.com>")');
  }
  const info = (await smtp().sendMail({
    from: !sender && fromName ? renamed(from, fromName) : from,
    to,
    subject,
    html,
    text,
    replyTo,
    headers,
    messageId,
    ...(attachments?.length && { attachments: attachments.map((a) => ({ filename: a.filename, contentType: a.contentType, content: Buffer.from(a.content) })) }),
  })) as { response?: string };
  return info.response ?? null;
}

/** `from` ("Acme <a@example.com>", or the bare address) with `name` as its sender's name. */
export function renamed(from: string, name: string): string {
  const address = from.match(/<([^<>]+)>\s*$/)?.[1] ?? from.trim();
  return `"${name}" <${address}>`;
}

/**
 * The Message-ID an email was delivered with, from the SMTP server's answer to it: Amazon SES
 * replaces ours with its own, `<id@email.amazonses.com>` (`<id@REGION.amazonses.com>` outside
 * us-east-1), and answers "250 Ok <id>". Null for other servers, which keep ours.
 */
export function deliveredMessageId(response: string | null, host = process.env.SMTP_HOST ?? ""): string | null {
  const id = response?.match(/^250 Ok ([0-9a-f]+(?:-[0-9a-f]+){5,})\s*$/i)?.[1];
  if (!id) {
    return null;
  }
  const region = host.match(/^email-smtp(?:-fips)?\.([a-z0-9-]+)\.amazonaws\.com$/i)?.[1]?.toLowerCase() ?? "us-east-1";
  return `<${id}@${region === "us-east-1" ? "email" : region}.amazonses.com>`;
}
