import { ASSET_PATH } from "@/lib/portal-base";

/** A platform a team's site may run on, with what to add there to put the portal under its path. */
export type SiteGuide = { id: string; name: string; where: string; language: string; code: string };

/**
 * Settings → Domain → Sub-folder: for each platform, the rules that forward `path` (e.g. /help)
 * and /_tuti to the portal's Tuti address (`tuti`, e.g. https://acme.tuti.so), paths and all, as
 * docs/site-path.md explains them, written out with the team's own path and address.
 */
export function siteGuides({ path, tuti }: { path: string; tuti: string }): SiteGuide[] {
  const origin = new URL(tuti).origin;
  const host = new URL(tuti).host;
  const rewrites = (splat: string) => [
    [`${path}/${splat}`, `${origin}${path}/${splat}`],
    [path, `${origin}${path}`],
    [`${ASSET_PATH}/${splat}`, `${origin}${ASSET_PATH}/${splat}`],
  ];
  const nginx = [`= ${path}`, `${path}/`, `${ASSET_PATH}/`]
    .map((location) => `location ${location} {\n    proxy_pass ${origin};\n    proxy_set_header Host ${host};\n    proxy_ssl_server_name on;\n}`)
    .join("\n");
  return [
    {
      id: "cloudflare",
      name: "Cloudflare",
      where: `A Worker on your site's routes ${path}, ${path}/* and ${ASSET_PATH}/* (not ${path}*, which would also take a page like ${path}-news).`,
      language: "js",
      code: `export default {\n  fetch(request) {\n    const url = new URL(request.url);\n    url.host = "${host}";\n    return fetch(new Request(url, request));\n  },\n};`,
    },
    {
      id: "vercel",
      name: "Vercel",
      where: "In vercel.json, whatever your framework:",
      language: "json",
      code: `{\n  "rewrites": [\n${rewrites(":path*")
        .map(([source, destination]) => `    { "source": "${source}", "destination": "${destination}" }`)
        .join(",\n")}\n  ]\n}`,
    },
    {
      id: "nextjs",
      name: "Next.js",
      where: "In next.config.ts, as beforeFiles rewrites, so they come before your own pages:",
      language: "ts",
      code: `async rewrites() {\n  return {\n    beforeFiles: [\n${rewrites(":path*")
        .map(([source, destination]) => `      { source: "${source}", destination: "${destination}" },`)
        .join("\n")}\n    ],\n  };\n},`,
    },
    {
      id: "netlify",
      name: "Netlify",
      where: "In _redirects (200 makes it a rewrite):",
      language: "text",
      code: rewrites("*")
        .map(([source, destination]) => `${source}  ${destination!.replace(/\*$/, ":splat")}  200!`)
        .join("\n"),
    },
    {
      id: "nginx",
      name: "Nginx",
      where: `Without a path after proxy_pass, the request's path stays as it is. ${path} and everything under it, not ${path}-news:`,
      language: "nginx",
      code: nginx,
    },
  ];
}
