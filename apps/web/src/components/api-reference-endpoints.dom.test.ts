// @vitest-environment happy-dom
import { act, createElement as h } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, test, vi } from "vitest";

const setApiReferenceShown = vi.fn();
vi.mock("@/server/api-references", () => ({ setApiReferenceShown, markApiReferenceSeen: async () => ({}) }));
vi.mock("sonner", () => ({ toast: { error: () => {} } }));

const { ApiReferenceEndpoints } = await import("./api-reference-endpoints");

afterEach(() => {
  document.body.replaceChildren();
  setApiReferenceShown.mockReset();
});

type Props = Parameters<typeof ApiReferenceEndpoints>[0];
const admin = (onHelpCenter: boolean): Props["groups"][number] => ({ key: "Admin", name: "Admin", description: "", onHelpCenter });
const deletePost: Props["operations"][number] = {
  key: "DELETE /posts/{id}", slug: "delete-a-post", title: "Delete a post", kind: "DELETE", path: "/posts/{id}", group: "Admin", alsoIn: [], deprecated: false, hidden: false, new: false,
};

async function endpoints(groups: Props["groups"]) {
  const box = document.createElement("div");
  document.body.append(box);
  const root = createRoot(box);
  const render = (next: Props["groups"]) => act(async () => root.render(h(ApiReferenceEndpoints, { projectSlug: "acme", slug: "api", state: null, published: true, groups: next, operations: [deletePost], unreadable: 0 })));
  await render(groups);
  const group = box.querySelector<HTMLInputElement>('[aria-label="Admin: on the help center"]')!;
  const operation = box.querySelector<HTMLInputElement>('[aria-label^="Delete a post"]')!;
  return { box, group, operation, render };
}

test("a group switched off stays off, its endpoints greyed, between its save's answer and the page that answer brings", async () => {
  setApiReferenceShown.mockResolvedValue({});
  const { box, group, operation, render } = await endpoints([admin(true)]);
  await act(async () => group.click());
  // Answered; the page is still the one from before the save.
  await vi.waitFor(() => expect(setApiReferenceShown).toHaveBeenCalledWith("acme", "api", "group", "Admin", false));
  await act(async () => {});
  expect(group.checked).toBe(false);
  expect(operation.getAttribute("aria-disabled")).toBe("true");
  expect(box.textContent).toContain("0 of 1 on the help center");
  // The page as saved, then a teammate's change: the switch follows the page.
  await render([admin(false)]);
  expect(group.checked).toBe(false);
  await render([admin(true)]);
  expect(group.checked).toBe(true);
  expect(operation.getAttribute("aria-disabled")).toBeNull();
});

test("the first page after the save is what the switch shows, though a teammate switched it back meanwhile", async () => {
  setApiReferenceShown.mockResolvedValue({});
  const { group, render } = await endpoints([admin(true)]);
  await act(async () => group.click());
  await vi.waitFor(() => expect(setApiReferenceShown).toHaveBeenCalled());
  await act(async () => {});
  expect(group.checked).toBe(false);
  await render([admin(true)]);
  expect(group.checked).toBe(true);
});

test("a refused save puts the switch back as it was", async () => {
  setApiReferenceShown.mockResolvedValue({ error: "Couldn't save that. Try again." });
  const { group, operation } = await endpoints([admin(true)]);
  await act(async () => group.click());
  await vi.waitFor(() => expect(group.checked).toBe(true));
  expect(operation.getAttribute("aria-disabled")).toBeNull();
});
