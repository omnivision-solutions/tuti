import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, test, vi } from "vitest";

vi.mock("@/server/invitations", () => ({}));

const { UnsentInvitations } = await import("./invitations");

const card = (tool: string | null, counted = false) =>
  renderToStaticMarkup(
    createElement(UnsentInvitations, { projectSlug: "acme", tool, counted, invitations: [{ id: "inv_1", email: "e2e-ines@example.com", title: "e2e-ines@example.com · Member", meta: "Imported", manageable: true }] }),
  ).replace(/<!-- -->/g, "");

test("imported invitations not sent yet say the tool they came from, or none when they came from more than one", () => {
  expect(card("Ferndesk")).toContain("From Ferndesk, not sent yet");
  expect(card("Ferndesk")).toContain("Your team in Ferndesk, invited as members. Nothing has been emailed: send the ones you want here.");
  expect(card(null)).toContain("Imported, not sent yet");
  expect(card(null)).toContain("Your team in the tools you imported from, invited as members.");
  // On a plan with a team limit, they count toward it.
  expect(card(null, true)).toContain("Until you remove them, they count toward your plan&#x27;s team members.");
});
