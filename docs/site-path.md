# Your portal under a path of your site

Your portal and help center can live under a path of your own site, like
`https://example.com/portal`: `example.com/portal/docs`, `example.com/portal/feedback/…`,
`example.com/portal/sign-in`. Your site keeps everything else; Tuti only answers under
that path.

In the Tuti app, your project's **Settings → Your site** (owners and admins): enter the
address, make your site forward two paths to Tuti, then **Check setup**. Until it's
checked, your portal stays at its own address.

## What your site forwards

Two rules, each to your portal's Tuti address (shown in Settings, e.g.
`https://acme.tuti.so`), **with the path kept as it is**:

| From | To |
| --- | --- |
| `/portal/*` | `https://acme.tuti.so/portal/*` |
| `/_tuti/*` | `https://acme.tuti.so/_tuti/*` |

`/_tuti` is your portal's scripts, styles and fonts. They're under a path of their own
so they can't clash with your site's (if your site is a Next.js app, its own `/_next` stays its own).

Forward the request as a proxy does (a rewrite, not a redirect): method, query string,
body and cookies as they are, and the Host header set to the Tuti address. Your visitors'
browsers only ever see your site.

**Check setup** asks your site for `/portal/.well-known/tuti-site` and
`/_tuti/.well-known/tuti-site`; through the rules above, Tuti answers both with your
project's token. Once both match, your portal answers at `example.com/portal`, every
link Tuti makes (emails, the sitemap, the API) goes there, and its Tuti address sends
people on to it.

## Next.js

In `next.config.ts`, as `beforeFiles` rewrites, so they win over your own pages:

```ts
async rewrites() {
  return {
    beforeFiles: [
      { source: "/portal/:path*", destination: "https://acme.tuti.so/portal/:path*" },
      { source: "/portal", destination: "https://acme.tuti.so/portal" },
      { source: "/_tuti/:path*", destination: "https://acme.tuti.so/_tuti/:path*" },
    ],
  };
},
```

## Vercel

In `vercel.json` (any framework):

```json
{
  "rewrites": [
    { "source": "/portal/:path*", "destination": "https://acme.tuti.so/portal/:path*" },
    { "source": "/portal", "destination": "https://acme.tuti.so/portal" },
    { "source": "/_tuti/:path*", "destination": "https://acme.tuti.so/_tuti/:path*" }
  ]
}
```

## Netlify

In `_redirects` (a `200` is a rewrite):

```
/portal/*  https://acme.tuti.so/portal/:splat  200!
/portal    https://acme.tuti.so/portal         200!
/_tuti/*   https://acme.tuti.so/_tuti/:splat   200!
```

## Nginx

```nginx
location /portal {
    proxy_pass https://acme.tuti.so;
    proxy_set_header Host acme.tuti.so;
    proxy_ssl_server_name on;
}
location /_tuti/ {
    proxy_pass https://acme.tuti.so;
    proxy_set_header Host acme.tuti.so;
    proxy_ssl_server_name on;
}
```

(`proxy_pass` without a path keeps the request's path as it is.)

## Cloudflare

A Worker on your site's routes `example.com/portal*` and `example.com/_tuti/*`:

```js
export default {
  fetch(request) {
    const url = new URL(request.url);
    url.hostname = "acme.tuti.so";
    return fetch(new Request(url, request));
  },
};
```

## Good to know

- **One path.** The portal can be under one path of one site (and also on a custom domain).
  Its own address keeps working for the widget, which your site embeds from there.
- **Sign-in.** People sign in on your site, under the path. Their Tuti session is a cookie
  on your site, named `tuti.…` so it can't clash with yours. Browsers send it with every
  request to your site, so your own servers see it too; it only signs people in to your
  portal. Signing in with your app (SSO) and "Continue with your Tuti account" work there too.
- **The path** can't start with one of the portal's own pages (`/docs`, `/feedback`,
  `/sign-in`, …), since the portal answers those at its own address.
- **Removing it** in Settings puts the portal back at its own address; remove the rules
  from your site too.
