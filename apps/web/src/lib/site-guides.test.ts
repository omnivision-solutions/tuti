import { expect, test } from "vitest";

import { siteGuides } from "./site-guides";

const guides = siteGuides({ path: "/help", tuti: "https://acme.tuti.so" });
const guide = (id: string) => guides.find((g) => g.id === id)!;

test("each platform's rules forward the path and /_tuti to the Tuti address, paths and all", () => {
  expect(guides.map((g) => g.name)).toEqual(["Cloudflare", "Vercel", "Next.js", "Netlify", "Nginx"]);
  expect(JSON.parse(guide("vercel").code)).toEqual({
    rewrites: [
      { source: "/help/:path*", destination: "https://acme.tuti.so/help/:path*" },
      { source: "/help", destination: "https://acme.tuti.so/help" },
      { source: "/_tuti/:path*", destination: "https://acme.tuti.so/_tuti/:path*" },
    ],
  });
  expect(guide("netlify").code).toBe(
    ["/help/*  https://acme.tuti.so/help/:splat  200!", "/help  https://acme.tuti.so/help  200!", "/_tuti/*  https://acme.tuti.so/_tuti/:splat  200!"].join("\n"),
  );
  expect(guide("nextjs").code).toContain('{ source: "/help/:path*", destination: "https://acme.tuti.so/help/:path*" },');
  expect(guide("cloudflare").code).toContain('url.host = "acme.tuti.so";');
  expect(guide("cloudflare").where).toContain("/help, /help/* and /_tuti/*");
  // Nginx: /help itself and under it, not /help-news; the Host is the Tuti address.
  expect(guide("nginx").code).toContain("location = /help {");
  expect(guide("nginx").code).toContain("location /help/ {");
  expect(guide("nginx").code).toContain("location /_tuti/ {");
  expect(guide("nginx").code).toContain("proxy_set_header Host acme.tuti.so;");
});

test("a Tuti address with a port (a local install) keeps it", () => {
  const local = siteGuides({ path: "/portal", tuti: "http://acme.localhost:3000" });
  expect(local.find((g) => g.id === "cloudflare")!.code).toContain('url.host = "acme.localhost:3000";');
});
