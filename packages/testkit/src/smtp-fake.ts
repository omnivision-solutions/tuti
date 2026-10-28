import type { AddressInfo } from "node:net";

import { simpleParser } from "mailparser";
import { SMTPServer } from "smtp-server";

export type CapturedEmail = {
  from: string;
  replyTo: string;
  to: string[];
  subject: string;
  text: string;
  html: string;
  /** Header values by lowercase name. */
  headers: Record<string, string>;
};

export type SmtpFake = {
  host: string;
  port: number;
  /** Every email received, oldest first. */
  emails: CapturedEmail[];
  /** The latest email to `address` (waits up to a few seconds for it to arrive). */
  latestTo(address: string): Promise<CapturedEmail>;
  /** Refuses the next email to `address` (a mail server rejecting it), then takes them again. */
  refuseNext(address: string): void;
  /** Answers the next email to `address` with `250 <answer>` (e.g. Amazon SES's "Ok <its message id>"). */
  answerNext(address: string, answer: string): void;
  close(): Promise<void>;
};

/**
 * A local SMTP server that keeps what it receives, for tests (SMTP_HOST / SMTP_PORT).
 * `onEmail` sees each email as it arrives (e.g. to share it with other processes);
 * the server answers once it's done, and refuses the email if it throws.
 */
export async function startSmtpFake({
  onEmail,
}: { onEmail?: (email: CapturedEmail) => void | Promise<void> } = {}): Promise<SmtpFake> {
  const emails: CapturedEmail[] = [];
  const refusing = new Set<string>();
  const answers = new Map<string, string>();
  const server = new SMTPServer({
    authOptional: true,
    disabledCommands: ["STARTTLS"],
    async onData(stream, _session, callback) {
      try {
        const mail = await simpleParser(stream);
        const to = (Array.isArray(mail.to) ? mail.to : mail.to ? [mail.to] : []).flatMap((a) =>
          a.value.map((v) => v.address ?? ""),
        );
        const email = {
          from: mail.from?.text ?? "",
          replyTo: mail.replyTo?.text ?? "",
          to,
          subject: mail.subject ?? "",
          text: mail.text ?? "",
          html: typeof mail.html === "string" ? mail.html : "",
          headers: Object.fromEntries(mail.headerLines.map((h) => [h.key, h.line.slice(h.line.indexOf(":") + 1).trim()])),
        };
        const refused = to.find((address) => refusing.has(address));
        if (refused) {
          refusing.delete(refused);
          throw new Error(`Mailbox ${refused} refused`);
        }
        await onEmail?.(email);
        emails.push(email);
        const answered = to.find((address) => answers.has(address));
        const answer = answered ? answers.get(answered) : undefined;
        if (answered) {
          answers.delete(answered);
        }
        callback(null, answer);
      } catch (error) {
        callback(error as Error);
      }
    },
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.server.address() as AddressInfo;

  return {
    host: "127.0.0.1",
    port,
    emails,
    async latestTo(address) {
      for (let i = 0; i < 50; i++) {
        const found = emails.findLast((e) => e.to.includes(address));
        if (found) {
          return found;
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      throw new Error(`No email to ${address} arrived`);
    },
    refuseNext: (address) => void refusing.add(address),
    answerNext: (address, answer) => void answers.set(address, answer),
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}
