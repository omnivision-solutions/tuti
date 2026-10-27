/**
 * Mail the support inbox doesn't take as a message from a user: auto-replies, bulk and list mail,
 * bounces, and its own mail coming back (docs/plan.md, Support inbox, "Noise and loops").
 *
 * The rules are ported from OpenDesk (https://github.com/useopendesk/opendesk, internal/email/parse.go
 * and trust.go), Copyright 2026 Mindroot Ltd, licensed under the Apache License 2.0
 * (http://www.apache.org/licenses/LICENSE-2.0). Changes: TypeScript; Tuti's own loop header.
 */

/** Every email Tuti sends carries it, so one that comes back is known (and so is a forward of it). */
export const LOOP_HEADER = "x-tuti-loop";

export type NoiseReason = "loop" | "bounce" | "auto_submitted" | "precedence" | "auto_reply" | "no_sender";

const AUTOMATIC_SUBJECTS = [
  "automatic reply",
  "auto reply",
  "auto-reply",
  "autoreply",
  "out of office",
  "out of the office",
  "abwesenheit",
  "réponse automatique",
  "respuesta automática",
  "risposta automatica",
];

type Mail = {
  /** Headers by lowercase name, as text. */
  headers: Map<string, string>;
  /** The From address, lowercase ("" when there's none). */
  from: string;
  subject: string;
  /** The envelope sender is empty (<>): a bounce or other report. */
  nullSender: boolean;
};

const localPart = (address: string) => address.slice(0, address.lastIndexOf("@")).toLowerCase();

/** Why this email isn't a message from a user, or null when it is. */
export function noiseReason(mail: Mail): NoiseReason | null {
  const header = (name: string) => mail.headers.get(name)?.trim() ?? "";
  if (!mail.from.includes("@")) {
    return "no_sender";
  }
  if (header(LOOP_HEADER)) {
    return "loop";
  }
  const contentType = header("content-type").toLowerCase();
  const deliveryReport = contentType.startsWith("multipart/report") && /report-type="?delivery-status/.test(contentType);
  if (["mailer-daemon", "postmaster"].includes(localPart(mail.from)) || (mail.nullSender && deliveryReport)) {
    return "bounce";
  }
  const autoSubmitted = header("auto-submitted").toLowerCase();
  if (autoSubmitted && autoSubmitted !== "no") {
    return "auto_submitted";
  }
  if (["bulk", "junk", "list", "auto_reply"].includes(header("precedence").toLowerCase())) {
    return "precedence";
  }
  if (header("x-autoreply") || header("x-autorespond")) {
    return "auto_reply";
  }
  const subject = mail.subject.toLowerCase();
  const looksAutomatic =
    AUTOMATIC_SUBJECTS.some((words) => subject.includes(words)) ||
    mail.headers.has("x-ms-exchange-generated-message-source") ||
    mail.headers.has("x-ms-exchange-inbox-rules-loop");
  if (mail.headers.has("x-auto-response-suppress") && looksAutomatic) {
    return "auto_reply";
  }
  return null;
}
