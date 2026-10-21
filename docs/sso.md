# Single sign-on (JWT)

Let users of your app post and vote on your Tuti board without creating a separate
account. Your server signs a short-lived token for the logged-in user and sends them
to Tuti, which signs them in.

## 1. Enable SSO

In the Tuti app, open your project's **Settings** (owners and admins) and click
**Enable SSO**. Copy the secret (`tsso_…`) — it's shown once. Store it on your
server only, e.g. as `TUTI_SSO_SECRET`. Never send it to the browser.

**Rotate secret** issues a new one and invalidates the old one immediately.
**Disable** turns SSO off.

## 2. Sign a token on your server

The token is a JWT signed with **HS256** using the secret.

| Claim | Required | Notes |
|---|---|---|
| `sub` | yes | Your user's id. Tuti matches users by this, so keep it stable. |
| `jti` | yes | A unique id per token (e.g. a UUID). Each token can be used **once**. |
| `iat` | yes | Issued-at time. |
| `exp` | yes | Expiry. At most **10 minutes** after `iat`; a few minutes is plenty. |
| `email` | no | Stored for notifications. Not used to match accounts. |
| `name` | no | Shown on posts and comments. Defaults to the part of the email before `@`. |
| `avatar` | no | `https` URL of the user's picture. |
| `groups` | no | Reader groups, e.g. `["enterprise"]`: which restricted collections in your docs they may read (see [Reader groups](#reader-groups)). Lowercase letters, digits and `- _ . :`, up to 20. Each sign-in replaces them, so leave one out to take it away. |

Node example with [`jose`](https://github.com/panva/jose):

```ts
import { SignJWT } from "jose";

const token = await new SignJWT({
  email: user.email,
  name: user.name,
  avatar: user.avatarUrl,
})
  .setProtectedHeader({ alg: "HS256" })
  .setSubject(String(user.id))
  .setJti(crypto.randomUUID())
  .setIssuedAt()
  .setExpirationTime("5m")
  .sign(new TextEncoder().encode(process.env.TUTI_SSO_SECRET));
```

Any JWT library works the same way (PyJWT, `golang-jwt`, `firebase/php-jwt`, …).

## 3. Send the user to Tuti

Redirect the user (or link them) to:

```
https://<project>.tuti.so/sso?token=<token>&redirect=<path>
```

(or your portal's custom domain). The exact URL is shown on the Settings page.

- `redirect` is optional: a path on your portal such as `/feedback/feature-requests`. Anything
  that isn't a same-site path is ignored, and the user lands on the portal's home page.
- The sign-in only applies to your portal: sessions are per portal, so these users
  aren't signed in anywhere else on Tuti.
- Create the token right before redirecting. Don't put tokens in emails or pages that
  get cached: they expire quickly and only work once.

A common pattern is a route in your app, e.g. `/feedback`, that signs a token for the
current user and redirects, so "Feedback" links in your app always sign users in.

## In the widget

The widget (`<script src="https://tuti.so/widget.js" data-project="acme" async>`) runs on
your site, where Tuti's own sign-in cookie can't reach it. Give it a way to get a fresh
token from your server, and your signed-in users post from the widget as themselves:

```html
<script>
  window.TutiSettings = {
    // Return a fresh token (or a promise of one) for the signed-in user.
    identify: () => fetch("/tuti-token").then((response) => response.text()),
  };
</script>
<script src="https://tuti.so/widget.js" data-project="acme" async></script>
```

`/tuti-token` is a route in your app that signs a token as in step 2. After the script
has loaded, `Tuti.identify(getToken)` does the same. The widget calls `getToken` each time
its panel opens a page that needs it, sends the token only to your portal, and keeps
the session it gets in the panel for up to 12 hours. Signed-out visitors (where
`getToken` returns nothing) can still sign in on the portal in a new tab.

What's new is per user too: when this browser hasn't seen your latest announcement, the
script calls `getToken` once and asks Tuti (`/api/widget/seen`, on the script's own origin)
whether the user has seen it on another device; after the panel shows it, it calls
`getToken` again to record that. So a user who reads What's new on their phone doesn't
see the dot on their laptop.

## Private portals

With **Settings → Portal access → Private**, only your team and the people your app signs in
this way can read the portal, its docs, changelog and feeds; everyone else gets the
sign-in page, and sign-up is off. In the widget, the panel asks visitors to sign in until
`getToken` gives it a token, then shows the portal to them.

Besides SSO users, **Readers** in the same settings lets in people (or whole domains) by
email, once their address is verified.

## Reader groups

Add your groups in **Settings → Groups** (owners and admins; or `groups.create`): a name, the
claim your token names the group by in `groups` (e.g. `enterprise`) and a description. The list
shows how many people your app has signed in with each. Changing a group's claim changes who's
in it.

A collection in your docs can be for some groups only: tick them under **Only for groups** on it
(or `groups`, their claims, in `collections.create` / `collections.update`). Then only your team
and people your app signs in with one of those groups in the token's `groups` claim see the collection, its
articles and the collections in it: in the docs, article pages, search, AI answers and
the widget. Everyone else (signed out, signed up on the portal, other groups) doesn't see them
at all, and `llms.txt` and the sitemap leave them out. A collection inside a restricted one is
restricted by both. A group a collection is for can't be deleted until it's removed there,
since that would open the collection to everyone.

Groups come from the latest sign-in: send all of a user's groups in every token (e.g. from
their plan), and a group they lose is gone the next time they sign in.

## Errors

If sign-in fails, the user sees an error page on your portal at `/sso/error?code=…`:

| Code | Meaning |
|---|---|
| `sso_not_enabled` | SSO is off for this project. |
| `invalid_token` | Bad signature, wrong algorithm (must be HS256), malformed, or missing `jti`/`sub`. |
| `expired_token` | `exp` is in the past. Check your server clock. |
| `token_lifetime_too_long` | `exp` is more than 10 minutes after `iat`, or `iat` is in the future. |
| `token_already_used` | The same `jti` was already used. Generate a new token per sign-in. |
| `invalid_claims` | A claim has the wrong type, e.g. `email` isn't an email or `avatar` isn't an https URL. |

## Security notes

- Users are matched by your `sub`, **never by email**. Your tokens can't sign anyone in
  as a user from another project or an existing Tuti account, even with the same email.
- Each `(project, sub)` is its own Tuti user. Signing a token for a user is equivalent
  to logging in as them on your board, so protect the secret like a password.
