import type { AddressInfo } from "node:net";

import { simpleParser } from "mailparser";
import { SMTPServer } from "smtp-server";

export type CapturedEmail = { from: string; to: string[]; subject: string; text: string; html: string };

export type SmtpFake = {
  host: string;
  port: number;
  /** Every email received, oldest first. */
  emails: CapturedEmail[];
  /** The latest email to `address` (waits up to a few seconds for it to arrive). */
  latestTo(address: string): Promise<CapturedEmail>;
  close(): Promise<void>;
};

/** A local SMTP server that keeps what it receives, for tests (SMTP_HOST / SMTP_PORT). */
export async function startSmtpFake(): Promise<SmtpFake> {
  const emails: CapturedEmail[] = [];
  const server = new SMTPServer({
    authOptional: true,
    disabledCommands: ["STARTTLS"],
    async onData(stream, _session, callback) {
      try {
        const mail = await simpleParser(stream);
        const to = (Array.isArray(mail.to) ? mail.to : mail.to ? [mail.to] : []).flatMap((a) =>
          a.value.map((v) => v.address ?? ""),
        );
        emails.push({
          from: mail.from?.text ?? "",
          to,
          subject: mail.subject ?? "",
          text: mail.text ?? "",
          html: typeof mail.html === "string" ? mail.html : "",
        });
        callback();
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
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}
