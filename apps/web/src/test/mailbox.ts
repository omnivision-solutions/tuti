import { startSmtpFake } from "@tuti/testkit/smtp";

/** Every email the app sends during a database test file (see setup.ts). */
export const mailbox = await startSmtpFake();
process.env.SMTP_HOST = mailbox.host;
process.env.SMTP_PORT = String(mailbox.port);
