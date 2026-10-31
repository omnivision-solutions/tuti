# Forwarding your own address to Tuti

Tuti gives each project a support address (Settings → Support → Email, like
`support@acme.tuti.email`). Emails to it land in the Inbox. To receive emails sent to your company's
address (`support@yourcompany.com`), forward that address to your support address at your email
provider. Your email stays with your provider; Tuti gets a copy of what reaches that one address.

Settings → Support → Your own address → Receiving emails shows both addresses with Copy, says which
provider receives your domain's email (from its MX records), and links to its section below.

Whichever provider you use:

- **Forward, keeping the sender.** Tuti answers whoever wrote. A forward that keeps the original
  sender (Gmail's forwarding, Exchange's mailbox forwarding, an alias or a routing rule) is right.
  An Outlook inbox rule's "Forward" sends a new email from your own address. Use "Redirect"
  instead.
- **Confirming.** Most providers send a confirmation (a link or a code) to the address you forward
  to before they start. It lands in your Tuti Inbox: open it there.
- **Checking.** Send an email to your own address from another account. Once it arrives,
  Receiving emails says "Forwarded" and when the last one came.
- **Keeping a copy** in your own mailbox is up to you. Tuti doesn't need it.
- **Not a mailing list.** A Google Group or another list with your Tuti address as a member sends
  list mail, which the Inbox ignores (along with auto-replies and bounces). Forward the address itself.

## Google Workspace

If `support@` is a user's mailbox (its owner signs in to it):

1. In Gmail, signed in as `support@yourcompany.com`, open Settings → See all settings →
   Forwarding and POP/IMAP.
2. Choose Add a forwarding address, enter your Tuti support address, then Next → Proceed → OK.
3. Gmail sends a confirmation link to that address. Open it in your Tuti Inbox and click the link.
4. Back in Gmail, refresh the settings page and pick Forward a copy of incoming mail to, with your
   Tuti address. Then Save Changes.

Gmail doesn't forward what it marks as spam. ([Google's guide](https://support.google.com/mail/answer/10957))

If `support@` isn't a mailbox (a group or an alias), or you'd rather set it for everyone, an admin
adds a routing rule (it delivers the email itself, not as list mail):

1. In the Admin console, open Apps → Google Workspace → Gmail → Routing, and Configure a new rule.
2. Under Email messages to affect, check Inbound and Internal - receiving.
3. Under Envelope filter, choose Only affect specific envelope recipients and enter
   `support@yourcompany.com`.
4. Under Also deliver to, check Add more recipients, and Add your Tuti support address.
5. Save. Rules can take up to an hour to apply.

([Google's guide](https://support.google.com/a/answer/6297084))

## Microsoft 365

An admin forwards the mailbox, or the shared mailbox, in the Exchange admin center:

1. Open Recipients → Mailboxes and pick `support@yourcompany.com`.
2. Under Mailbox → Email forwarding, choose Manage email forwarding.
3. Turn on Forward all emails sent to this mailbox, choose Forward to an external email address and
   enter your Tuti support address.
4. To keep a copy in the mailbox, check Deliver message to both forwarding address and mailbox.
   Save.

Microsoft 365 blocks forwarding outside your organization by default. If emails bounce with
`5.7.520 Access denied, Your organization does not allow external forwarding`, open the Microsoft
Defender portal → Email & collaboration → Policies & rules → Threat policies → Anti-spam. Edit
the outbound policy, or add one for just this mailbox, and set Automatic forwarding rules to
On - Forwarding is enabled.
([Forwarding](https://learn.microsoft.com/exchange/recipients-in-exchange-online/manage-user-mailboxes/configure-email-forwarding),
[external forwarding](https://learn.microsoft.com/defender-office-365/outbound-spam-policies-external-email-forwarding))

## Zoho Mail

1. Signed in as `support@yourcompany.com`, open Settings → Mail Accounts and pick the address.
2. Under Forwards, enter your Tuti support address. Leave Delete original email copy after
   forwarding unchecked to keep a copy.
3. Zoho emails a code to that address. Copy it from your Tuti Inbox, then click Verify next to the
   address, enter the code and Confirm.

An admin can set it instead: Admin Console → Users → the user → Mailbox settings → Email
Forwarding. Zoho's free plan doesn't forward.
([Zoho's guide](https://www.zoho.com/mail/help/email-forwarding.html))

## Fastmail

If `support@` is an alias, open Settings → Aliases (or My email addresses), edit
`support@yourcompany.com`, and add your Tuti support address under Deliver to. Keep your own address
there too to keep a copy.

If it's a user's own address, add a rule under Settings → Filters & Rules that forwards its email to
your Tuti support address.

If forwarded emails don't arrive, turn on SRS for the forwarding.
([Fastmail's guide](https://www.fastmail.help/hc/en-us/articles/360060591073-How-to-set-up-aliases))

## Proton Mail

Forwarding needs a paid Proton plan.

1. Open Settings → All settings → Forward and auto-reply, then Add forwarding rule.
2. Pick `support@yourcompany.com` in Forward from, and enter your Tuti support address in Forward to.
3. Skip the conditions (Next) and Send confirmation email.
4. The invitation lands in your Tuti Inbox. Open it and click Accept forwarding.

Proton's end-to-end encryption stops for emails forwarded outside Proton.
([Proton's guide](https://proton.me/support/email-forwarding))

## Cloudflare Email Routing

1. In the Cloudflare dashboard, open your account's Email Routing → Destination Addresses, and add
   your Tuti support address.
2. Cloudflare emails it a link. Open it in your Tuti Inbox and click Verify email address.
3. On your domain's Email Routing → Routing Rules, Create routing rule: `support` at your domain,
   action Send to an email, destination your Tuti support address.

([Cloudflare's guide](https://developers.cloudflare.com/email-routing/setup/email-routing-addresses/))

## No email provider yet

If nothing receives email for your domain (it has no MX records), set up a forwarding service for it
first. [Cloudflare Email Routing](#cloudflare-email-routing) (when your DNS is at Cloudflare) and
[ImprovMX](https://improvmx.com) are free: add their MX records, then forward
`support@yourcompany.com` to your Tuti support address.

## Other providers

Look in your provider's settings for forwarding, an alias, or a mail routing rule for
`support@yourcompany.com`, and send it to your Tuti support address. Pick an option that keeps the
original sender. Then send a test email, as above.
