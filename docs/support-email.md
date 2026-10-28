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

Attachments come with the email: images show in the conversation, other files download under their
name. They're kept in the server's file storage (`MEDIA_S3_*`); without it, the message says how many
weren't kept.

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
- **Limits:** 10 senders connected at once, 3 from one address, each session 10 minutes at most; 10
  messages being received or delivered at once; 20 recipients per message. Past them, senders are told
  to come back later or to send the rest separately, as SMTP expects.

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

#### Sending under a tenant per project

With the `SES_*` settings (see `apps/web/.env.example`), each project's email goes out under an SES
tenant of its own (`<configuration set>-<project id>`), so SES pauses only a project whose mail
draws bounces or complaints, and an address that complains about one project isn't suppressed for
another (each tenant has its own suppression list). Before a project's first email, the app creates
its tenant and associates the support domain's identity and the configuration set with it (SES
refuses mail naming a tenant they aren't associated with); every email names both
(`X-SES-TENANT`, `X-SES-CONFIGURATION-SET`). `infra/ses-sending/deploy.sh` makes the topic the
configuration set's events go to (`SES_EVENTS_TOPIC_ARN`) and the user the app's key is for, which
may only manage tenants and identities.

#### Sending from the team's own domain

On a Pro plan, with the `SES_*` settings, a team can have replies come from its own address
(`support@acme.com`) instead of the project's support address: Settings → Support takes the
address, the app adds its domain to SES (Easy DKIM, tagged with the project) and shows the 3 CNAMEs
SES gives. Once SES finds them ("Check", and a daily check), replies come from that address under
the project's tenant, with the domain associated with it; Reply-To stays the conversation's own
address, so replies still come back. If SES stops finding them, replies come from the project's
support address again, with the reason on Settings → Support. A domain is one project's alone; one
SES already has for anything else, or under a domain that sends for anyone else, is refused, and one
nobody verifies within a week is let go. Removing it has SES forget it.

Teams' domains can be anything, so the API user and the SMTP user `infra/ses-sending` makes may act
on any identity in their region: deploy it in a region whose SES has only Tuti's identities (SES
keeps identities, quotas and production access per region), with the support domain and the domain
Tuti's own mail comes from verified there.

#### The project's other emails

With email on, what a project sends its users (portal sign-in links and password resets, "<name> gave
you access", "it shipped") comes from the project too: `"<Project>" <updates@<subdomain>.<domain>>`,
or `updates@` the team's own domain once it's verified, under the project's tenant, with Reply-To
its support address while the inbox is on, so answers land in the Inbox. On a server selling plans,
"it shipped" waits for the operator's approval like replies do; sign-in links never wait. Tuti's own
mail to teams (sign-up, invites, credits) stays on `EMAIL_FROM`, and without `SUPPORT_EMAIL_DOMAIN`
everything does.

#### Bounces and complaints

SES's events (sends, deliveries, bounces, complaints) go through SNS to `/api/email/events`, subscribed
by `infra/ses-sending/deploy.sh` run again with `APP_URL` once the app has the `SES_*` settings (it confirms the subscription). The app
checks SNS's signature and takes only `SES_EVENTS_TOPIC_ARN`'s messages, each once. A message's
email shows as delivered, bounced (with the receiving server's reason) or marked as spam, and its
state only moves forward, so a late delivery never hides a bounce. Someone who marks a project's
email as spam gets no more email from it; replies still reach them in the widget.

On a server selling plans, every email a project sends (replies, "shipped", sign-in links, …) is
tagged with the project (`X-SES-MESSAGE-TAGS`), and its events add up per project and day: sent,
bounced for good, and complaints, kept a month. Updating the stack from before send events
(`infra/ses-sending/deploy.sh` again) adds them.
