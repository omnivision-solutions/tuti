# Widget

A button on your site that opens a panel with your project's feedback form, what's
new (the changelog) and, once you've published articles, help. Add one script tag
anywhere in your pages:

```html
<script src="https://tuti.so/widget.js" data-project="acme" async></script>
```

`data-project` is your project's URL name. The panel is your portal's `/widget` page in
an iframe, so your site's styles can't reach it and it needs no API key.

## Launcher

In the Tuti app, your project's **Settings → Widget** (owners and admins) sets:

- **Button label** (default "Feedback", up to 30 characters).
- **Colour** (default the Tuti green; the text on it is black or white, whichever reads better).
- **Position**: bottom right or bottom left.
- **Quick links**: up to 5 links (a label and an `https://` address) at the top of the
  panel, such as your status page or docs. They open in a new tab.

The script reads these once per page view; changes show up within a minute. The same
settings are in the API as `widget.get` and `widget.update` (`/api/v1/widget`).

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

Any element with `data-tuti-article` opens the panel at that help article when clicked,
including elements added to the page later (single-page apps):

```html
<a href="https://acme.tuti.so/help/exporting-your-data" data-tuti-article="exporting-your-data">How do exports work?</a>
```

The value is the article's URL name (the end of its `/help/…` address). With an `href`,
the link still works where the script isn't loaded; with the script, it opens the
panel instead of leaving the page.

## JavaScript

`window.Tuti` is there once the script has run:

| Call | What it does |
| --- | --- |
| `Tuti.open()` | Opens the panel where it was (the Feedback tab the first time). |
| `Tuti.open({ tab })` | Opens it at a tab: `"feedback"`, `"whats-new"` or `"help"`. |
| `Tuti.open({ article: "<slug>" })` | Opens it at a help article. |
| `Tuti.close()` | Closes it (as do Escape and the panel's close button). |
| `Tuti.identify(getToken)` | Signs your users in with SSO: see [sso.md](sso.md#in-the-widget). |
| `Tuti.unseen()` | `true` when there's an announced changelog entry (from the last 30 days) this browser hasn't seen in What's new. |
| `Tuti.on("unseen", callback)` | Calls `callback(unseen)` once the status is known and whenever it changes, e.g. to put a dot on your own button. |

```js
Tuti.on("unseen", (unseen) => {
  document.querySelector("#whats-new-dot").hidden = !unseen;
});
```

Tuti's own button shows the same status as a dot. What a browser has seen is kept in
your site's `localStorage` (`tuti:seen:<project>`), so it's per browser, not per user.

Before the script loads, `window.TutiSettings` takes `identify` and `hideLauncher`.

The panel's text is in English for now; there's no `locale` setting yet.
