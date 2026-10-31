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
  /** Files attached to it. */
  attachments: { filename: string; contentType: string; content: Buffer }[];
};

export type SmtpFake = {
  host: string;
  port: number;
  /** Every email received, oldest first. */
  emails: CapturedEmail[];
  /** The latest email to `address` (waits up to a few seconds for it to arrive). */
  latestTo(address: string): Promise<CapturedEmail>;
  /**
   * Refuses the next email to `address` (a mail server rejecting it), then takes them again. By default
   * the message, for now (450); with `code`, the message with that code (554: the provider won't send
   * it, a server-side refusal); `permanently`, the address itself (550 at RCPT TO, as for one that doesn't exist).
   */
  refuseNext(address: string, options?: { permanently?: boolean; code?: number }): void;
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
  // The address refused next: its message with a code, or (`recipient`) the address itself.
  const refusing = new Map<string, number | "recipient">();
  const answers = new Map<string, string>();
  const server = new SMTPServer({
    authOptional: true,
    disabledCommands: ["STARTTLS"],
    onRcptTo(address, _session, callback) {
      if (refusing.get(address.address) === "recipient") {
        refusing.delete(address.address);
        callback(Object.assign(new Error(`Mailbox ${address.address} unavailable`), { responseCode: 550 }));
        return;
      }
      callback();
    },
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
          attachments: mail.attachments.map((a) => ({ filename: a.filename ?? "", contentType: a.contentType, content: a.content })),
        };
        const refused = to.find((address) => typeof refusing.get(address) === "number");
        if (refused) {
          const responseCode = refusing.get(refused) as number;
          refusing.delete(refused);
          throw Object.assign(new Error(`Mailbox ${refused} refused`), { responseCode });
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
    refuseNext: (address, options) => void refusing.set(address, options?.permanently ? "recipient" : (options?.code ?? 450)),
    answerNext: (address, answer) => void answers.set(address, answer),
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}
