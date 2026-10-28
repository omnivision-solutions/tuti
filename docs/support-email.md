# Support email

With email on, every project's support inbox has an address of its own: `support@<subdomain>.<domain>`,
where `<subdomain>` comes from the project's URL name when it first gets one (with a number added if
it's taken) and stays the project's for good. Emails to it land in the Inbox as conversations. The
team forwards its own support address (like `support@acme.com`) there in its email provider, so its
users keep writing to the address they know.

## For teams

1. In Settings → Support, under Email, choose **Get a support address** and copy it.
2. In your email provider, forward your support address to it:
   - Google Workspace or Gmail: Settings → Forwarding and POP/IMAP → Add a forwarding address. Gmail
     sends a confirmation email to the address; it lands in your Inbox in Tuti, with the code or link
     to confirm.
   - Microsoft 365: a mail flow rule or the mailbox's forwarding settings (your admin may need to allow
     forwarding outside your organisation).
   - Others: their forwarding settings, or a rule that redirects every message.
3. Send your support address a test email: it shows in the Inbox, and Settings → Support says when
   the last email came in.

Mailing lists (like Google Groups) don't work for forwarding: their mail is list mail, which the inbox
ignores along with auto-replies and bounces.

A reply from someone comes back into its conversation when it's sent to the conversation's own
address (replies by email set it as Reply-To) by its person, and their mail passed DMARC; anything
else starts a new conversation. Mail that failed DMARC goes to Spam.

## For servers

Email is on with both of these set (see `apps/web/.env.example`):

| Setting | What it is |
| --- | --- |
| `SUPPORT_EMAIL_DOMAIN` | The domain projects' addresses are on (`<subdomain>.<domain>`). Mail for its subdomains must reach your receiver: a wildcard MX record, `*.<domain>`. |
| `INBOUND_SECRET` | A random secret (at least 32 characters) the receiver signs each message with. |

The receiver (an SMTP server, a mail provider's inbound hook, a script) posts each message to
`/api/inbound/email`:

- the raw message (RFC 5322, as received) as the request body, up to 25 MB;
- `Tuti-Recipient`: the envelope recipient, the project's address it came to;
- `Tuti-Auth`: the receiver's results, as `spf=<result> dkim=<result> dmarc=<result>` (`pass`, `fail` or
  `none`); without a DMARC check of your own, send `dmarc=none`, and nothing joins an existing
  conversation or matches a user by address;
- `Tuti-Signature`: `t=<unix seconds>,v1=<HMAC-SHA256, hex>`, keyed with `INBOUND_SECRET`, over
  `<t>.<recipient>.<auth>.<SHA-256 of the body, hex>`, within 5 minutes of the server's clock.

It answers `200` once the message is taken (or ignored as an auto-reply, a bounce or a loop, or refused
over a limit: 500 emails an hour per project), `404` for an address no project has, `401` for a bad
signature, `413` over 25 MB, and `500` when the receiver should try again (a redelivery of the same
message is taken once). A project's mail waiting to be read is capped at 1 GB, and the server's at 20 GB.

### Your own server

The worker can receive the mail itself: an SMTP server for the support domain's addresses, off unless
`INBOUND_SMTP_PORT` is set (see `apps/worker/.env.example`).

- **DNS:** point the domain's subdomains at the worker's host, `*.<domain> MX 10 <host>`, and open
  port 25 to it (map it to `INBOUND_SMTP_PORT` if the worker listens on another).
- **Settings:** the worker needs `SUPPORT_EMAIL_DOMAIN` and `INBOUND_SECRET` (the web app's values)
  and `APP_URL`. Set `INBOUND_SMTP_NAME` to the MX host's name. With `INBOUND_SMTP_TLS_KEY` and
  `INBOUND_SMTP_TLS_CERT` (PEM files), it offers STARTTLS; without them, mail arrives unencrypted.
- **What it does:** it takes mail only for `<anything>@<subdomain>.<domain>` (it relays nothing), checks
  SPF, DKIM and DMARC itself, and posts each message to the app signed with `INBOUND_SECRET`. The
  sending server hears what the app answered: taken, refused (no project has the address, or the
  message is over 25 MB), or "try again later" while the app is down or set up wrong (its email off,
  or a different `INBOUND_SECRET`, which the worker logs), so the sending server retries on its own.

### Amazon SES (tuti.so)

On tuti.so, Amazon SES receives mail for `tuti.email`, and a small Lambda posts it
(`infra/ses-inbound`, which works for any domain verified in SES):

- **The receipt rule** matches every subdomain of the domain, scans for spam and viruses, stores each
  message in a private S3 bucket and invokes the Lambda.
- **The Lambda** (`index.mjs`) posts the message once per recipient, with SES's SPF, DKIM and DMARC
  verdicts as `Tuti-Auth`, signed with `INBOUND_SECRET`, and deletes the stored copy once the app
  has it (or has refused it for good). A message SES found a virus in isn't posted.
- **When the app is down**, Lambda tries twice more within minutes; then the invocation goes to a retry
  queue that brings it back every 10 minutes for a day, and after that to a dead-letter queue (kept 14
  days). The app takes a message it already has once, and one that's no longer stored (an earlier try
  posted it) is done with. Anything never posted expires from the bucket after 7 days.

To set it up, verify the domain in SES, then run `infra/ses-inbound/deploy.sh` with AWS credentials and
`SUPPORT_EMAIL_DOMAIN`, `APP_URL` and `INBOUND_SECRET` set. It deploys the stack (`template.yaml`),
uploads the Lambda's code and makes the rule set the active one: SES has one active rule set per
region. Then add a wildcard MX record, `*.<domain> MX 10 inbound-smtp.<region>.amazonaws.com`. Replies
go out through SES's SMTP too, so its SMTP user may send from `*@*.<domain>`.
