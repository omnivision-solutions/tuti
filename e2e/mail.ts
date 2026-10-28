import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import type { CapturedEmail } from "@tuti/testkit/smtp";

/** Emails the app sent during the run; the global setup writes each one here. */
export const MAIL_DIR = "e2e-mail";

function emailsTo(address: string): CapturedEmail[] {
  return readdirSync(MAIL_DIR)
    .filter((file) => file.endsWith(".json"))
    .sort()
    .map((file) => JSON.parse(readFileSync(join(MAIL_DIR, file), "utf8")) as CapturedEmail)
    .filter((email) => email.to.includes(address));
}

/** How many emails `address` has received so far. */
export const countEmailsTo = (address: string) => emailsTo(address).length;

/**
 * The latest email to `address`, waiting up to 10 seconds for one. With `after`
 * (a count from countEmailsTo), waits for an email newer than those; with `subject`, for one whose
 * subject matches (another journey may be emailing the same address at once).
 */
export async function latestEmailTo(address: string, { after = 0, subject }: { after?: number; subject?: RegExp } = {}): Promise<CapturedEmail> {
  for (let i = 0; i < 100; i++) {
    const emails = emailsTo(address)
      .slice(after)
      .filter((email) => !subject || subject.test(email.subject));
    if (emails.length > 0) {
      return emails.at(-1)!;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`No new email to ${address} arrived`);
}

/** The first link in an email that starts with `prefix` (e.g. an app URL). */
export function linkIn(email: CapturedEmail, prefix: string): string {
  const link = email.text.split(/\s+/).find((word) => word.startsWith(prefix));
  if (!link) {
    throw new Error(`No ${prefix} link in "${email.subject}"`);
  }
  return link;
}
