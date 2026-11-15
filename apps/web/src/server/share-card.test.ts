import { renderToStaticMarkup } from "react-dom/server";
import satori from "satori";
import { expect, test, vi } from "vitest";

import type { Branding } from "@/server/operations/branding";

import { cardElement, drawable, fonts, logoSize, type ShareCard } from "./share-card";

test("a card's text loses emoji and their parts, which its fonts can't draw", () => {
  expect(drawable("Launch 🇫🇷 day")).toBe("Launch day");
  expect(drawable("Thanks 👍🏽 team")).toBe("Thanks team");
  expect(drawable("Family 👨‍👩‍👧 plan")).toBe("Family plan");
  expect(drawable("Step 1️⃣ done ✅")).toBe("Step 1 done");
  expect(drawable("Café déjà vu")).toBe("Café déjà vu");
  // © ® ™ stay: the fonts have them.
  expect(drawable("Acme™ © ®")).toBe("Acme™ © ®");
});

test("a logo is read at the smallest stored width twice what the card shows it at, never scaled up", () => {
  // A wide wordmark: 360 wide at most (the text's side is 652), from the 960px copy (480 would be blown up).
  expect(logoSize({ width: 2000, height: 250 })).toEqual({ width: 360, height: 45, stored: 960 });
  // A square mark: 64×64, from the smallest copy.
  expect(logoSize({ width: 512, height: 512 })).toEqual({ width: 64, height: 64, stored: 480 });
  // Smaller than twice its size on the card: the original.
  expect(logoSize({ width: 300, height: 100 })).toEqual({ width: 192, height: 64, stored: 300 });
});

test("the card's fonts draw every character a card keeps: symbols (✓ ⋯ →) from Noto Sans Math, Cyrillic and Greek, ©®™", async () => {
  // Satori asks for another font for any character none of them has (and would draw a box without one).
  const missing = vi.fn(async () => []);
  const text = drawable("✓ Done: export ⋯ → CSV ↔ Привет Γειά Acme™ © Łódź 🎉 🇫🇷");
  const element = { type: "div", key: null, props: { style: { display: "flex", fontFamily: "Figtree" }, children: text } };
  await satori(element, { width: 1200, height: 100, fonts: await fonts, loadAdditionalAsset: missing });
  expect(missing.mock.calls).toEqual([]);
});

test('a card says "Powered by tuti" as the portal does: not once the team has hidden it', () => {
  const site = (poweredBy: boolean) => ({ project: { name: "Acme" }, brand: { color: "#6d4aff", colorScheme: "light", logoText: null, poweredBy } as unknown as Branding });
  const card = { eyebrow: "Feature requests", title: "Dark mode", facts: ["Planned", "42 votes"], picture: { votes: 42 } } satisfies ShareCard;
  const shown = renderToStaticMarkup(cardElement(site(true), card, "https://acme.example", null));
  expect(shown).toContain("Powered by");
  // The votes on the panel, in the team's colour.
  expect(shown).toContain(">42<");
  expect(renderToStaticMarkup(cardElement(site(false), card, "https://acme.example", null))).not.toContain("Powered by");
});

test("on a pale colour the panel's shapes are dark, as white ones would vanish; the votes' number takes a shade of the colour that reads on white", () => {
  const card = (color: string, picture: ShareCard["picture"]) =>
    renderToStaticMarkup(
      cardElement({ project: { name: "Acme" }, brand: { color, colorScheme: "light", logoText: null, poweredBy: false } as unknown as Branding }, { eyebrow: "", title: "Roadmap", picture }, "https://acme.example", null),
    );
  expect(card("#f5d90a", "roadmap")).toContain("rgba(28,25,23,");
  expect(card("#f5d90a", "roadmap")).not.toContain("rgba(255,255,255,");
  expect(card("#6d4aff", "roadmap")).toContain("rgba(255,255,255,");
  // White cards on a white panel get an edge.
  for (const picture of ["page", "board", { votes: 3 }] as const) {
    expect(card("#ffffff", picture)).toContain("rgba(28,25,23,0.18)");
    expect(card("#6d4aff", picture)).not.toContain("rgba(28,25,23,0.18)");
  }
  // Yellow on white doesn't read: the number is a darker yellow.
  expect(card("#f5d90a", { votes: 3 })).not.toMatch(/[;"]color:#f5d90a/);
});
