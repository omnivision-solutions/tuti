import { render } from "@react-email/render";
import nodemailer, { type Transporter } from "nodemailer";
import type { ReactElement } from "react";

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

/**
 * Sends an email built from a React Email template. Without SMTP_HOST (local
 * development, installs without email) it's written to the log instead.
 */
export async function sendEmail({ to, subject, body }: { to: string; subject: string; body: ReactElement }) {
  const [html, text] = await Promise.all([render(body), render(body, { plainText: true })]);
  if (!process.env.SMTP_HOST) {
    console.info(`[email not sent: SMTP_HOST is not set]\nTo: ${to}\nSubject: ${subject}\n\n${text}\n`);
    return;
  }
  await smtp().sendMail({ from: process.env.EMAIL_FROM || "Tuti <team@tuti.so>", to, subject, html, text });
}
