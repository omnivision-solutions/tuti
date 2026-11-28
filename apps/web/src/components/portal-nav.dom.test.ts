// @vitest-environment happy-dom
import { act, createElement as h } from "react";
import { createRoot } from "react-dom/client";
import { expect, test, vi } from "vitest";

vi.mock("@/server/changelog-seen", () => ({ markChangelogSeen: async () => ({}) }));
vi.stubEnv("APP_URL", "https://tuti.example");
vi.stubEnv("PORTAL_URL_TEMPLATE", "https://{project}.tuti.example");

const { useNewChangelog } = await import("./portal-nav");
const { CHANGELOG_SEEN } = await import("./changelog-seen");

test("the header's New goes once the visit is recorded, and comes back with a later announcement the layout brings", async () => {
  const box = document.createElement("div");
  document.body.append(box);
  const root = createRoot(box);
  const Probe = ({ newChangelog }: { newChangelog: boolean }) => String(useNewChangelog(newChangelog));
  const render = (newChangelog: boolean) => act(async () => root.render(h(Probe, { newChangelog })));

  await render(true);
  expect(box.textContent).toBe("true");
  await act(async () => void window.dispatchEvent(new Event(CHANGELOG_SEEN)));
  expect(box.textContent).toBe("false");
  // A refresh after the visit: nothing new; then one with an announcement made since.
  await render(false);
  await render(true);
  expect(box.textContent).toBe("true");
  await act(async () => root.unmount());
});
