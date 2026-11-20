// @vitest-environment happy-dom
import { act, createElement as h } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, test, vi } from "vitest";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => {} }) }));
vi.mock("@/server/portal-settings", () => ({}));

const { OwnAddressSettings } = await import("./own-address");

const domain = { hostname: "help.example.com", status: "verified" as const, certificate: null, records: [] };

afterEach(() => document.body.replaceChildren());

test("a domain removed moves focus to the option still picked only where focus was lost, not from a control that's still there", async () => {
  const outside = document.createElement("button");
  document.body.append(outside);
  const box = document.createElement("div");
  document.body.append(box);
  const root = createRoot(box);
  const render = (withDomain: boolean) =>
    act(async () =>
      root.render(
        h(OwnAddressSettings, {
          projectSlug: "acme",
          domain: withDomain ? domain : null,
          site: null,
          domainsOn: true,
          notIncluded: { domain: null, site: null },
          portalAddress: "acme.tuti.so",
          protocol: "https:",
        }),
      ),
    );
  // A teammate removed it while focus is on a control that stays: it stays there.
  await render(true);
  outside.focus();
  await render(false);
  expect(document.activeElement).toBe(outside);
  // This person removed it, and its Remove button, which had focus, went with it: focus goes to the option picked.
  await render(true);
  outside.blur();
  expect(document.activeElement).toBe(document.body);
  await render(false);
  expect(document.activeElement?.getAttribute("role")).toBe("radio");
  expect(document.activeElement?.getAttribute("aria-checked")).toBe("true");
});
