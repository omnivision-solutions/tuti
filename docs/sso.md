# Single sign-on (JWT)

Let users of your app post and vote on your Tuti board without creating a separate
account. Your server signs a short-lived token for the logged-in user and sends them
to Tuti, which signs them in.

## 1. Enable SSO

Open your workspace's **Settings** (link on your board, visible to owners and admins)
and click **Enable SSO**. Copy the secret (`tsso_…`) — it's shown once. Store it on your
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
https://<your Tuti host>/<workspace>/sso?token=<token>&redirect=<path>
```

- `redirect` is optional: a path on Tuti such as `/acme/feature-requests`. Anything that
  isn't a same-site path is ignored, and the user lands on your workspace instead.
- Create the token right before redirecting. Don't put tokens in emails or pages that
  get cached: they expire quickly and only work once.

A common pattern is a route in your app, e.g. `/feedback`, that signs a token for the
current user and redirects, so "Feedback" links in your app always sign users in.

## Errors

If sign-in fails, the user sees an error page at `/<workspace>/sso/error?code=…`:

| Code | Meaning |
|---|---|
| `sso_not_enabled` | SSO is off for this workspace. |
| `invalid_token` | Bad signature, wrong algorithm (must be HS256), malformed, or missing `jti`/`sub`. |
| `expired_token` | `exp` is in the past. Check your server clock. |
| `token_lifetime_too_long` | `exp` is more than 10 minutes after `iat`, or `iat` is in the future. |
| `token_already_used` | The same `jti` was already used. Generate a new token per sign-in. |
| `invalid_claims` | A claim has the wrong type, e.g. `email` isn't an email or `avatar` isn't an https URL. |

## Security notes

- Users are matched by your `sub`, **never by email**. Your tokens can't sign anyone in
  as a user from another workspace or an existing Tuti account, even with the same email.
- Each `(workspace, sub)` is its own Tuti user. Signing a token for a user is equivalent
  to logging in as them on your board, so protect the secret like a password.
