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
