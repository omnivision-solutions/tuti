# Domain Connect templates

"Add with Cloudflare" beside DNS records in Settings (a custom domain's CNAME and TXT, the 3 DKIM
CNAMEs of the support address): Domain Connect, which Cloudflare, GoDaddy, IONOS and other DNS
providers support. Tuti finds the domain's provider (`_domainconnect` TXT), and shows the button only
when that provider has taken these templates; the link it makes is signed with `DOMAIN_CONNECT_KEY`
(`apps/web/src/server/domain-connect.ts`). Without the key, nobody sees it.

These templates are Tuti's (`providerId` tuti.so), so this is for tuti.so: a self-hosted server
would need templates and a key of its own.

## Setting it up

1. The key: an RSA key, its private half (PKCS#8 DER, base64) as `DOMAIN_CONNECT_KEY` on the web app:

   ```sh
   node -e 'const { privateKey } = require("node:crypto").generateKeyPairSync("rsa", { modulusLength: 2048 }); console.log(privateKey.export({ format: "der", type: "pkcs8" }).toString("base64"))'
   ```

2. Its public half in DNS, as TXT records at `_dck1.tuti.so` (one per line this prints):

   ```sh
   node -e 'const c = require("node:crypto"); const d = c.createPublicKey(c.createPrivateKey({ key: Buffer.from(process.env.DOMAIN_CONNECT_KEY, "base64"), format: "der", type: "pkcs8" })).export({ format: "der", type: "spki" }).toString("base64"); d.match(/.{1,200}/g).forEach((part, i) => console.log(`p=${i + 1},a=RS256,d=${part}`))'
   ```

3. The templates: a pull request adding both files to
   [Domain-Connect/Templates](https://github.com/Domain-Connect/Templates) (check them first with its
   linter's `-cloudflare` option).

4. Once it's merged, email domain-connect@cloudflare.com: the two templates' GitHub links,
   `_dck1.tuti.so` for the key, Tuti's logo (SVG), and DNS only (not proxied) as the records' proxy
   status (SES must see the DKIM CNAMEs, and Cloudflare for SaaS the custom domain's).

5. Any other provider with Domain Connect (GoDaddy, IONOS, …) works the same once it has the
   templates: nothing changes in Tuti, which asks the domain's own provider. Each takes templates its
   own way, most from that repository; the button shows for a provider as soon as it answers yes.

Anyone can add a domain to their own project and get a signed link for it, someone else's domain
too, and send it to that domain's owner. That's Domain Connect as every service using it works: the
owner sees exactly which records and for whom at their own DNS provider, and approves them there,
as they would records sent to type in by hand. Settings only shows the link to the project's admins.

A new key goes at a new name (`_dck2`) and `KEY_HOST` in `domain-connect.ts`, with the old one kept
until no link signed with it can be open.
