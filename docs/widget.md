# Widget

A button on your site that opens a panel with your project's feedback form, what's
new (the changelog), your docs once you've published articles, and Messages to your team
once you turn the support inbox on (see [Messages](#messages)). It opens at Home: a way
into each of those, and your quick links. The tabs are at the bottom of the panel, with
"Powered by tuti" under them unless your project hides it (Customize → Powered by). Add one
script tag anywhere in your pages:

```html
<script src="https://tuti.so/widget.js" data-project="acme" async></script>
```

`data-project` is your project's URL name. The panel is your portal's `/widget` page in
an iframe, so your site's styles can't reach it and it needs no API key.

## Launcher

The launcher is a round button with an icon. In the Tuti app, your project's
**Customize → Widget** (owners and admins) sets:

- **Button name** (default "Feedback", up to 30 characters): what screen readers say, and
  the button's tooltip. It isn't shown on the button.
- **Colour** (default the Tuti green; the icon on it is black or white, whichever reads better).
- **Position**: bottom right or bottom left.
- **Icon**: a chat bubble (the default), a question mark, a megaphone, a light bulb, or an
  image you upload (a square one with a transparent background works best; it shows at 28
  pixels). On tuti.so, picking one other than the chat bubble needs the Pro plan; a project
  that moves to the free plan keeps its choice, and the launcher shows the chat bubble until
  the plan is back. Self-hosted, every project can pick one.
- **Quick links**: up to 5 links (a label and an `https://` address) on the panel's Home,
  such as your status page or docs. They open in a new tab.

The script reads these once per page view; changes show up within a minute. The same
settings are in the API as `widget.get` and `widget.update` (`/api/v1/widget`).

## Display

`data-display` on the script tag (or `display` in `TutiSettings`) says how the widget shows:

| Value | What visitors see |
| --- | --- |
| `launcher` (default) | The button, which opens the panel above it. |
| `sidebar` | The button, which opens the panel as a full-height drawer on its side (right, or left with a bottom-left button). On screens up to 640px wide the rest of the page is dimmed, and tapping it closes the drawer. |
| `inline` | No button: the panel shows in your page, where you put it (see below). |

```html
<!-- Launcher (the default) -->
<script src="https://tuti.so/widget.js" data-project="acme" async></script>

<!-- Sidebar -->
<script src="https://tuti.so/widget.js" data-project="acme" data-display="sidebar" async></script>

<!-- Inline -->
<div data-tuti-inline></div>
<script src="https://tuti.so/widget.js" data-project="acme" data-display="inline" async></script>
```

or before the script loads:

```html
<script>window.TutiSettings = { display: "sidebar" };</script>
```

The attribute wins over `TutiSettings`. In every mode, `Tuti.open()` and article links open
the panel (in `inline` mode, the floating one, as with `data-hide-launcher`).

### Inline

Every element with `data-tuti-inline` gets its own panel, in any display mode, so a page can
have a launcher and an inline panel, or several inline ones (say Feedback on one side and
What's new on the other). The attribute's value picks its tab: `home`, `messages`, `docs`,
`feedback` or `whats-new`; empty (`<div data-tuti-inline>`) is Home, and so is an unknown one,
with an error in the browser console. The panel fills the element's width and height, and is at least 500px tall; give the
element a height to make it taller. It has no close button, since there's nothing to close.
Elements added to the page later (single-page apps) get their panel when they appear.

```html
<section style="height: 700px">
  <div data-tuti-inline="whats-new" style="height: 100%"></div>
</section>
```

## Your own button

To leave out Tuti's button and open the panel from your own, add `data-hide-launcher`:

```html
<script src="https://tuti.so/widget.js" data-project="acme" data-hide-launcher async></script>
<button onclick="Tuti.open()">Feedback</button>
```

or set `hideLauncher` before the script loads:

```html
<script>window.TutiSettings = { hideLauncher: true };</script>
```

## Contextual help

Any element with `data-tuti-article` opens the panel at that article when clicked,
including elements added to the page later (single-page apps):

```html
<a href="https://acme.tuti.so/docs/exporting-your-data" data-tuti-article="exporting-your-data">How do exports work?</a>
```

The value is the article's URL name (the end of its `/docs/…` address). With an `href`,
the link still works where the script isn't loaded; with the script, it opens the
panel instead of leaving the page.

## JavaScript

`window.Tuti` is there once the script has run:

| Call | What it does |
| --- | --- |
| `Tuti.open()` | Opens the panel where it was (Home the first time). |
| `Tuti.open({ tab })` | Opens it at a tab: `"home"`, `"messages"`, `"docs"`, `"feedback"` or `"whats-new"`. |
| `Tuti.open({ article: "<slug>" })` | Opens it at an article from your docs. |
| `Tuti.close()` | Closes it (as do Escape and the panel's close button). Inline panels stay. |
| `Tuti.identify(getToken)` | Signs your users in with SSO: see [sso.md](sso.md#in-the-widget). |
| `Tuti.unseen()` | `true` when there's an announced changelog entry (from the last 30 days) this visitor hasn't seen in What's new, or, with the support inbox on, a reply from your team they haven't seen in Messages. |
| `Tuti.on("unseen", callback)` | Calls `callback(unseen)` once the status is known and whenever it changes, e.g. to put a dot on your own button. |

```js
Tuti.on("unseen", (unseen) => {
  document.querySelector("#whats-new-dot").hidden = !unseen;
});
```

Tuti's own button shows the same status as a dot. What a browser has seen is kept in
your site's `localStorage` (`tuti:seen:<project>`). For users you sign in with
`identify`, it's also kept per user, so seeing it on one device clears it on the others
(the later of the two counts; see [sso.md](sso.md#in-the-widget)). Signed in on your
portal, the Changelog tab says "New" until they've looked.

Before the script loads, `window.TutiSettings` takes `identify`, `hideLauncher` and `display`.

## Messages

With Settings → Support → Messages in the widget on, the panel has a Messages tab where
the people you sign in with `identify` (or on your portal) write to your team and read
its replies; your team answers them from the Inbox in Tuti. The tab checks for replies
every 10 seconds while it's open, and Tuti's button shows a dot (and `Tuti.unseen()` is
`true`) while a reply is waiting for them (for people you sign in). People who aren't
signed in leave their email to write; the panel keeps a token for 30 days in its own
storage (per site, out of your page's reach) so they see their conversations when they come
back, and drops it when your page signs someone in. Their address isn't verified, and it's
never linked to one of your users: the team only sees that it may be them.

The panel's text is in English for now; there's no `locale` setting yet.
