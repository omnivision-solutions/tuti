// Amazon SES receives mail for the support domain (tuti.so: `tuti.email`), stores each message in S3
// and invokes this Lambda, which posts it to the app's /api/inbound/email, signed like any receiver
// (docs/support-email.md, "For servers"), and deletes the stored copy once the app has it.
// Deployed by deploy.sh with template.yaml; nothing else in the repo imports it.

import { createHash, createHmac } from "node:crypto";

/** SES's verdict as the app reads it: `pass`, `fail`, or `none` (not checked, or no answer). */
export function verdict(result) {
  const status = String(result?.status ?? "").toUpperCase();
  return status === "PASS" ? "pass" : status === "FAIL" ? "fail" : "none";
}

/** `Tuti-Signature` for one recipient (apps/web/src/lib/inbound-signature.ts checks it). */
export function sign(secret, recipient, auth, raw, now = Date.now()) {
  const t = Math.floor(now / 1000);
  const hash = createHash("sha256").update(raw).digest("hex");
  return `t=${t},v1=${createHmac("sha256", secret).update(`${t}.${recipient}.${auth}.${hash}`).digest("hex")}`;
}

/**
 * Posts one SES receipt's message to the app, once per recipient on the support domain. The app says
 * 200 once it has it (or ignores it), 404 for an address no project has, 401 or 413 for what trying
 * again won't fix: all of those are done with. Anything else throws, so Lambda tries the whole event
 * again (the app takes a message it already has once). The stored copy goes once every recipient is
 * done with; what's left expires with the bucket's lifecycle rule.
 */
export async function deliver(record, { appUrl, secret, domain, getRaw, deleteRaw, post, log = console }) {
  const { mail, receipt } = record.ses;
  if (verdict(receipt.virusVerdict) === "fail") {
    log.warn(`Dropped ${mail.messageId}: SES found a virus`);
    await deleteRaw(mail.messageId);
    return { delivered: 0 };
  }
  const suffix = `.${domain.toLowerCase()}`;
  const recipients = receipt.recipients.map((r) => r.toLowerCase()).filter((r) => r.endsWith(suffix));
  const auth = `spf=${verdict(receipt.spfVerdict)} dkim=${verdict(receipt.dkimVerdict)} dmarc=${verdict(receipt.dmarcVerdict)}`;
  const raw = await getRaw(mail.messageId);
  if (!raw) {
    // Gone: an earlier try posted it and deleted it (or it expired). Nothing left to do.
    log.warn(`${mail.messageId} isn't stored any more`);
    return { delivered: 0 };
  }
  let delivered = 0;
  for (const recipient of recipients) {
    const status = await post(new URL("/api/inbound/email", appUrl).toString(), {
      body: raw,
      headers: {
        "content-type": "message/rfc822",
        "tuti-recipient": recipient,
        "tuti-auth": auth,
        "tuti-signature": sign(secret, recipient, auth, raw),
      },
    });
    if (status === 200) {
      delivered++;
    } else if (status === 404 || status === 401 || status === 413) {
      log.warn(`The app refused ${mail.messageId} for ${recipient}: ${status}`);
    } else {
      throw new Error(`The app answered ${status} for ${mail.messageId} (${recipient}): trying again`);
    }
  }
  await deleteRaw(mail.messageId);
  return { delivered };
}

/**
 * The SES receipts in an invocation: SES's own, or, from the retry queue, those of an invocation that
 * failed every try Lambda gave it (the queue holds Lambda's failure record, the original event inside).
 */
export function sesRecords(event) {
  return (event.Records ?? []).flatMap((record) => {
    if (record.eventSource === "aws:sqs") {
      return sesRecords(JSON.parse(record.body).requestPayload ?? {});
    }
    return record.ses ? [record] : [];
  });
}

export async function handler(event) {
  const { DeleteObjectCommand, GetObjectCommand, S3Client } = await import("@aws-sdk/client-s3");
  const s3 = new S3Client({});
  const { APP_URL, INBOUND_SECRET, SUPPORT_EMAIL_DOMAIN, BUCKET, PREFIX = "inbound/" } = process.env;
  const key = (messageId) => `${PREFIX}${messageId}`;
  for (const record of sesRecords(event)) {
    await deliver(record, {
      appUrl: APP_URL,
      secret: INBOUND_SECRET,
      domain: SUPPORT_EMAIL_DOMAIN,
      getRaw: async (messageId) => {
        try {
          const object = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: key(messageId) }));
          return Buffer.from(await object.Body.transformToByteArray());
        } catch (error) {
          if (error.name === "NoSuchKey") {
            return null;
          }
          throw error;
        }
      },
      deleteRaw: (messageId) => s3.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: key(messageId) })),
      post: async (url, { body, headers }) => {
        const response = await fetch(url, { method: "POST", body, headers, signal: AbortSignal.timeout(50_000) });
        return response.status;
      },
    });
  }
}
