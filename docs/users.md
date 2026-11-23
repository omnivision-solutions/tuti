# Your users

Tuti knows your app's users by their id in your app, with what you tell it about them: a name, an
email, an avatar and **properties** (plan, support tier, seats, …). [Reader groups](sso.md#reader-groups)
are conditions on those properties, so you decide who reads what in your docs from what you
already know about your users.

Users come in three ways, all matched by the same id:

- **Single sign-on**: the token's `sub` and `properties` (see [SSO](sso.md#properties)); the widget's
  `identify` uses the same token.
- **The API**, `users.sync`: up to 1,000 users per call, e.g. from a nightly job or your AI agent.
- **Acting for someone** (`author` on `posts.create` and the like) adds them too.

Your team sees them on the **Users** page in the app: searchable by name, email or id, filtered
by group, each with their properties and the groups they're in.

Someone who signs in to your portal another way (an email link, a password) is in the groups of
the users with their address, once it's verified.

## Syncing users

`POST /api/v1/users` with a read and write key:

```json
{
  "users": [
    {
      "id": "user-42",
      "name": "Sam from Acme",
      "email": "sam@acme.example",
      "properties": { "plan": "enterprise", "seats": 40, "features": ["sso", "audit"], "trial": null }
    }
  ]
}
```

- `id` is required: the user's id in your app (the `sub` of your SSO tokens), up to 255 characters.
- Only what you send changes. `properties` sets the ones it names and removes the ones that are
  `null`; the rest stay. `email` and `avatar` can be `null` to clear them.
- Properties are strings (up to 200 characters), numbers, booleans or lists of up to 50 strings,
  with names up to 64 characters; a user has up to 50.
- All or nothing: a bad user (a value of another type, more than 50 properties, the same `id`
  twice) refuses the whole call with `400`, naming the problem.
- The answer says how many users were `created` and `updated`.

`GET /api/v1/users` lists them by name (`q` finds them by name, email or id; `limit` and `cursor`
page through them), and `GET /api/v1/users/{id}` gets one, each with their properties and the
`groups` (keys) they're in now.

## Deleting users

When someone deletes their account in your app, or asks to be forgotten, `DELETE /api/v1/users/{id}`
with a read and write key (`users.delete`) removes them from Tuti too:

- Their name, email, avatar and properties go, as do their votes (vote counts follow), the posts
  they follow, their comment likes and changelog reactions, email preferences and this project's changelog email
  subscription for their address.
- They're signed out at once: portal sessions end and widget tokens stop working.
- What they wrote stays for your team, shown as by **Deleted user**: their posts, comments and
  support conversations (with those started by email from their address, verified), with their
  email address taken off them, so replies are no longer emailed to them.
- The same id signing in or synced again later is a new, empty user.
- An id there's no user with is `404`.

While their address is still someone else's too (another of your users with it, such as a shared
mailbox, or a portal account that verified it), nothing that goes by the address is changed: their
changelog subscription and messages from it stay, and conversations started by email from it stay with the address.

Tuti knows only the address you gave them last. An email they sent from an earlier one (before a
sync changed it) is in the thread as from someone else, and keeps that address; so does a
conversation they started by email from it.

An account someone made on your portal another way (an email link, a password) is theirs, not
your app's, and isn't touched.
