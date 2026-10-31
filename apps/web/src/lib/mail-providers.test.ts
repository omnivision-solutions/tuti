import { expect, test } from "vitest";

import { EMAIL_FORWARDING_DOCS, mailProvider } from "./mail-providers";

test("a domain's email provider comes from its MX hosts, with its section of the forwarding guide", () => {
  expect(mailProvider(["aspmx.l.google.com", "alt1.aspmx.l.google.com"])).toEqual({ name: "Google Workspace", docs: `${EMAIL_FORWARDING_DOCS}#google-workspace` });
  expect(mailProvider(["smtp.google.com"])).toMatchObject({ name: "Google Workspace" });
  expect(mailProvider(["acme-com.mail.protection.outlook.com"])).toMatchObject({ name: "Microsoft 365" });
  // Its DNSSEC endpoints, for newer domains.
  expect(mailProvider(["acme-com.o-v1.mx.microsoft"])).toMatchObject({ name: "Microsoft 365" });
  expect(mailProvider(["mx.zoho.eu", "mx2.zoho.eu"])).toMatchObject({ name: "Zoho Mail" });
  expect(mailProvider(["mx.zoho.com.au"])).toMatchObject({ name: "Zoho Mail" });
  expect(mailProvider(["mx.zoho.ae", "mx2.zoho.ae"])).toMatchObject({ name: "Zoho Mail" });
  expect(mailProvider(["in1-smtp.messagingengine.com"])).toMatchObject({ name: "Fastmail" });
  expect(mailProvider(["mail.protonmail.ch"])).toMatchObject({ name: "Proton Mail" });
  expect(mailProvider(["route1.mx.cloudflare.net"])).toMatchObject({ name: "Cloudflare Email Routing" });
  // Not fooled by a name that only contains a provider's.
  expect(mailProvider(["google.com.mx.example.net"])).toBe("other");
  expect(mailProvider(["mx.zoho.example.net"])).toBe("other");
  expect(mailProvider([])).toBe("none");
});
