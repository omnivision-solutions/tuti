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
| `email` | no | Stored for notifications. Not used to sign anyone in; someone who signs in to your portal another way with this address, once it's verified, gets this user's groups (see [Properties](#properties)). |
| `name` | no | Shown on posts and comments. Defaults to the part of the email before `@`. |
| `avatar` | no | `https` URL of the user's picture. |
| `groups` | no | Reader groups, e.g. `["enterprise"]`: which tabs, collections and articles for some groups in your docs they may read (see [Reader groups](#reader-groups)). Lowercase letters, digits and `- _ . :`, up to 20. Each sign-in replaces them, so leave one out to take it away. |
| `properties` | no | What you know about the user, e.g. `{ "plan": "pro", "seats": 12 }`, for groups' conditions to match (see [Properties](#properties)). Strings, numbers, booleans and lists of strings, up to 50. Each sign-in sets the ones it names; `null` removes one. (`attributes`, their old name, still works.) |

Node example with [`jose`](https://github.com/panva/jose):

```ts
import { SignJWT } from "jose";

const token = await new SignJWT({
  email: user.email,
  name: user.name,
  avatar: user.avatarUrl,
  // Optional: for reader groups (see below).
  groups: user.isBetaTester ? ["beta"] : [],
  properties: { plan: user.plan, role: user.role },
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

With **Settings → Access → Portal access → Private**, only your team and the people your app signs in
this way can read the portal, its docs, changelog and feeds; everyone else gets the
sign-in page, and sign-up is off. In the widget, the panel asks visitors to sign in until
`getToken` gives it a token, then shows the portal to them.

Besides SSO users, **Readers** in the same settings lets in people (or whole domains) by
email, once their address is verified.

## Reader groups

Add your groups in **Settings → Access → Groups** (owners and admins; or `groups.create`): a name, a
description, and who's in it, by either or both of:

- **SSO group name**: the claim your token names the group by in `groups` (e.g. `enterprise`).
- **Conditions** on the user's [properties](#properties), all of which must match (up to 10). Each is a
  property, an operator (**is**, **is not** or **is one of**, with the values comma-separated) and
  a value, e.g. `plan` is one of `pro, enterprise`.

Someone is in the group when their `groups` has its name, or when its conditions (if it has any)
all match their properties. While you write the conditions, the dialog shows how many of the people
your app has signed in match them now, with a few of their names; the list shows the same for each
group. Changing a group's name in `groups` or its conditions changes who's in it.

How conditions compare:

- Values compare as text, exactly: capital letters and spaces count (`Pro` isn't `pro`), and the
  property's name must match exactly too.
- Numbers and booleans compare as their text: `"seats": 12` is `12`, `"beta": true` is `true`.
- A list matches **is** (and **is one of**) when one of its items does, and **is not** when none does.
- **is not** also matches when the user has no such property.
- Only your app's users can be in a group: the people it signs in, and people signed in to your
  portal another way whose verified address is one of your users' `email`. Signed-out visitors and
  everyone else are in none, even for a group whose only condition is "is not".

Each group has a `key`, made from its name when you add it and never changed: the API's
`/groups/{key}` and the `groups` on `tabs.*`, `collections.*` and `articles.*` name groups by it
(`groups.list` has them).

### Who can read

Each tab, collection and article in your docs has **Who can read** (the tab's **Access**, the
collection's dialog, the article's editor; `access` on `tabs.*`, `collections.*` and `articles.*`):

- **Inherit** (`inherit`, the default): whoever may read what it's in. For a tab, everyone who
  may read your portal.
- **Signed-in readers** (`signed_in`): anyone signed in on your portal, however they signed in.
- **Specific groups** (`groups`, with `groups`: their keys): people your app signs in who are in one
  of them. With none picked, only your team.

A page is for whoever every level above it lets in: its tab, each collection it's in, then the
page itself, so a collection or article can only narrow what's above it (an article in no
collection is under the first tab). Your team reads everything. Everyone else doesn't see what
isn't for them at all: in the docs, the tabs, article pages and their `.md`, search, AI answers and
the widget. `llms.txt` and the sitemap only list what's for everyone. In the API, `groups` without
`access` still works as it did for collections: some groups mean `groups`, none `inherit`.

**People without access** (`noAccess`) says what everyone else sees of a page, from the nearest
level that says (the page, each collection it's in, then its tab):

- **Hide** (`hide`, what happens when no level says): nothing. It isn't listed, and its link is
  "not found", so nobody learns it's there.
- **Show with a lock** (`lock`): its title is listed with a lock (in the docs, the tabs, the tree,
  search results and the widget; search matches its title only), and its page shows the title and
  "Sign in to read this." (signed out) or "You don't have access to this.", never its text. Its
  `.md`, AI answers, `llms.txt` and the sitemap stay closed, and the page is `noindex`. A locked
  tab or collection shows nothing inside it.
- **Inherit** (`inherit`, the default).

**Preview as a reader**, next to it in the app, opens the page on your portal as people signed out
see it (`?preview=signed-out`, which only changes what your team sees).

A group a tab, collection or article is for can't be deleted until it's removed there, so who can
read what never changes behind your back.

Groups come from the latest sign-in: send all of a user's groups in every token, and one they lose
is gone the next time they sign in. Properties change only where a token names them (see below).

### Properties

The token's `properties` is an object of what your app knows about the user, by name, for
conditions to match. You can also send them over the API, for users who haven't signed in yet (see
[Your users](users.md)).

```json
{
  "sub": "user-42",
  "jti": "5f0c6c1e-8f5a-4a4e-9d55-2b8f3c1d7a10",
  "iat": 1760000000,
  "exp": 1760000300,
  "name": "Sam from Acme",
  "groups": ["beta"],
  "properties": { "plan": "enterprise", "role": "admin", "company": "Acme", "seats": 40, "sso": true, "features": ["audit", "saml"] }
}
```

- Names are up to 64 characters (spaces around them are trimmed); values are strings (up to 200
  characters), numbers, booleans or lists of up to 50 strings; a user has up to 50 of them (new
  ones past that are left out).
- Each sign-in sets the ones it names and keeps the rest; `null` removes one (`"plan": null`).
  A token without `properties` changes none.
- Anything else (an object as a value, a list of anything but strings, a name too long) is left
  out, one by one: a bad property never stops the user signing in.
- `attributes`, their old name, still works; where both name a property, `properties` wins.

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
