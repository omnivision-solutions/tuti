import { expect, test } from "vitest";

import { inboundSignatureValid } from "@/lib/inbound-signature";

import { deliver, sesRecords, verdict } from "./index.mjs";

const SECRET = "a-test-secret-of-at-least-32-characters";
const raw = Buffer.from("From: kim@example.com\r\nTo: support@acme.tuti.email\r\nSubject: Help\r\n\r\nHello");

/** An SES receipt event's record, as the Lambda action gets it. */
const record = (receipt: Record<string, unknown> = {}) => ({
  ses: {
    mail: { messageId: "ses-message-1" },
    receipt: {
      recipients: ["support@acme.tuti.email"],
      spfVerdict: { status: "PASS" },
      dkimVerdict: { status: "PASS" },
      dmarcVerdict: { status: "PASS" },
      virusVerdict: { status: "PASS" },
      ...receipt,
    },
  },
});

function fakes(answers: { status: number; outcome?: string }[] = []) {
  const posts: { url: string; headers: Record<string, string>; body: Buffer }[] = [];
  const deleted: string[] = [];
  return {
    posts,
    deleted,
    options: {
      appUrl: "https://app.example.com",
      secret: SECRET,
      domain: "tuti.email",
      getRaw: async (id: string) => (id === "ses-message-1" ? raw : Buffer.alloc(0)),
      deleteRaw: async (id: string) => void deleted.push(id),
      post: async (url: string, request: { headers: Record<string, string>; body: Buffer }) => {
        posts.push({ url, ...request });
        return answers.shift() ?? { status: 200, outcome: "conversation" };
      },
      log: { warn: () => {} },
    },
  };
}

test("each message goes to the app signed the way the app checks, with SES's results, and its stored copy goes", async () => {
  const { posts, deleted, options } = fakes();
  expect(await deliver(record({ dmarcVerdict: { status: "FAIL" }, dkimVerdict: { status: "GRAY" } }), options)).toEqual({ delivered: 1 });
  expect(posts).toHaveLength(1);
  const [post] = posts;
  expect(post!.url).toBe("https://app.example.com/api/inbound/email");
  expect(post!.body.equals(raw)).toBe(true);
  expect(post!.headers["tuti-recipient"]).toBe("support@acme.tuti.email");
  expect(post!.headers["tuti-auth"]).toBe("spf=pass dkim=none dmarc=fail");
  expect(inboundSignatureValid(SECRET, post!.headers["tuti-signature"]!, "support@acme.tuti.email", "spf=pass dkim=none dmarc=fail", raw)).toBe(true);
  // Another recipient or other results can't reuse the signature.
  expect(inboundSignatureValid(SECRET, post!.headers["tuti-signature"]!, "support@other.tuti.email", "spf=pass dkim=none dmarc=fail", raw)).toBe(false);
  expect(deleted).toEqual(["ses-message-1"]);
});

test("only the support domain's addresses are posted, each on its own", async () => {
  const { posts, options } = fakes();
  await deliver(record({ recipients: ["Support@Acme.Tuti.Email", "support@beta.tuti.email", "someone@example.com", "x@tuti.email.evil.com"] }), options);
  expect(posts.map((post) => post.headers["tuti-recipient"])).toEqual(["support@acme.tuti.email", "support@beta.tuti.email"]);
});

test("an answer to try again throws, keeping the stored copy; one that won't change is done with", async () => {
  const retry = fakes([{ status: 500 }]);
  await expect(deliver(record(), retry.options)).rejects.toThrow("trying again");
  expect(retry.deleted).toEqual([]);

  const unknown = fakes([{ status: 404, outcome: "no such address" }]);
  expect(await deliver(record(), unknown.options)).toEqual({ delivered: 0 });
  expect(unknown.deleted).toEqual(["ses-message-1"]);

  // The app set up wrong (its email off: a 404 without that outcome; a different INBOUND_SECRET: 401)
  // keeps the mail for another try, until the operator fixes it.
  for (const answer of [{ status: 404 }, { status: 401 }]) {
    const misconfigured = fakes([answer]);
    await expect(deliver(record(), misconfigured.options)).rejects.toThrow("trying again");
    expect(misconfigured.deleted).toEqual([]);
  }
});

test("a message no longer stored (posted by an earlier try) is done with, not tried again", async () => {
  const { posts, options } = fakes();
  expect(await deliver(record(), { ...options, getRaw: async () => null })).toEqual({ delivered: 0 });
  expect(posts).toEqual([]);
});

test("a message SES found a virus in isn't posted", async () => {
  const { posts, deleted, options } = fakes();
  expect(await deliver(record({ virusVerdict: { status: "FAIL" } }), options)).toEqual({ delivered: 0 });
  expect(posts).toEqual([]);
  expect(deleted).toEqual(["ses-message-1"]);
});

test("SES's verdicts read as the app's words", () => {
  expect([verdict({ status: "PASS" }), verdict({ status: "FAIL" }), verdict({ status: "GRAY" }), verdict({ status: "PROCESSING_FAILED" }), verdict(undefined)]).toEqual([
    "pass",
    "fail",
    "none",
    "none",
    "none",
  ]);
});

test("SES's own event and, from the retry queue, a failed invocation's event give the same receipts", () => {
  const ses = { Records: [{ eventSource: "aws:ses", ...record() }] };
  // Lambda's failure record for an invocation that ran out of tries, as the queue delivers it.
  const retried = { Records: [{ eventSource: "aws:sqs", body: JSON.stringify({ requestContext: { condition: "RetriesExhausted" }, requestPayload: ses }) }] };
  expect(sesRecords(ses)).toEqual(ses.Records);
  expect(sesRecords(retried)).toEqual(ses.Records);
  expect(sesRecords({ Records: [{ eventSource: "aws:sqs", body: "{}" }] })).toEqual([]);
});
