import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import type { CapturedEmail } from "@tuti/testkit/smtp";

/** Emails the app sent during the run; the global setup writes each one here. */
export const MAIL_DIR = "e2e-mail";

/** The latest email to `address`, waiting up to 10 seconds for it. */
export async function latestEmailTo(address: string): Promise<CapturedEmail> {
  for (let i = 0; i < 100; i++) {
    const emails = readdirSync(MAIL_DIR)
      .sort()
      .map((file) => JSON.parse(readFileSync(join(MAIL_DIR, file), "utf8")) as CapturedEmail);
    const found = emails.findLast((email) => email.to.includes(address));
    if (found) {
      return found;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`No email to ${address} arrived`);
}

/** The first link in an email that starts with `prefix` (e.g. an app URL). */
export function linkIn(email: CapturedEmail, prefix: string): string {
  const link = email.text.split(/\s+/).find((word) => word.startsWith(prefix));
  if (!link) {
    throw new Error(`No ${prefix} link in "${email.subject}"`);
  }
  return link;
}
