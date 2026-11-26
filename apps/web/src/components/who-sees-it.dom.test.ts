// @vitest-environment happy-dom
import { act, createElement as h, useContext } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, test, vi } from "vitest";

const publishChangelogEntry = vi.fn(async () => ({}));
vi.mock("@/server/changelog", () => ({ publishChangelogEntry }));
vi.mock("@/server/images", () => ({}));
vi.mock("@/server/branding", () => ({}));
vi.mock("@/server/widget", () => ({}));
vi.mock("@/server/media", () => ({}));

const { ChangelogEntryActions, ChangelogSaving, ChangelogSavingContext, WhoSeesIt } = await import("./changelog");

afterEach(() => document.body.replaceChildren());

const groups = [
  { key: "enterprise", name: "Enterprise" },
  { key: "beta", name: "Beta" },
];
const upgrade = { title: "Reader groups need the Business plan", billingHref: null, note: null };

async function picker() {
  const box = document.createElement("form");
  document.body.append(box);
  const onChange = vi.fn();
  await act(async () => createRoot(box).render(h(WhoSeesIt, { groups, picked: ["enterprise"], upgrade, onChange })));
  const box_ = (key: string) => box.querySelector<HTMLInputElement>(`input[value="${key}"]`)!;
  const sent = () => box.querySelector('input[name="groupsEditable"]') !== null;
  return { box: box_, sent, onChange };
}

test("on a plan without reader groups, picking one opens the upgrade prompt and changes nothing: the save after it doesn't send the groups", async () => {
  const { box, sent, onChange } = await picker();
  await act(async () => box("beta").click());
  expect(box("beta").checked).toBe(false);
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain("Reader groups need the Business plan");
  expect(sent()).toBe(false);
  expect(onChange).not.toHaveBeenCalled();
});

test("unpicking one works on such a plan, and is sent", async () => {
  const { box, sent, onChange } = await picker();
  await act(async () => box("enterprise").click());
  expect(box("enterprise").checked).toBe(false);
  expect(sent()).toBe(true);
  expect(onChange).toHaveBeenCalled();
});

test("on such a plan, a group the entry is saved with can be ticked again after unticking it", async () => {
  const { box, onChange } = await picker();
  await act(async () => box("enterprise").click());
  await act(async () => box("enterprise").click());
  expect(box("enterprise").checked).toBe(true);
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  expect(onChange).toHaveBeenCalledTimes(2);
});

test("Publish is told of an unsaved pick only while the picker that has it is there: once the form is replaced (new saved text), the pick and the hold go together", async () => {
  const box = document.createElement("form");
  document.body.append(box);
  const root = createRoot(box);
  const Held = () => h("output", null, String(useContext(ChangelogSavingContext)?.groupsChanged));
  const render = (picker: boolean) =>
    act(async () => root.render(h(ChangelogSaving, null, h(Held), picker && h(WhoSeesIt, { groups, picked: [], upgrade: null, onChange: () => {} }))));
  await render(true);
  expect(box.querySelector("output")?.textContent).toBe("false");
  await act(async () => box.querySelector<HTMLInputElement>('input[value="some"]')!.click());
  await act(async () => box.querySelector<HTMLInputElement>('input[value="beta"]')!.click());
  expect(box.querySelector("output")?.textContent).toBe("true");
  await render(false);
  expect(box.querySelector("output")?.textContent).toBe("false");
});

test("while a save runs the picks wait: one made then would be dropped as the picker starts afresh after it", async () => {
  const box = document.createElement("form");
  document.body.append(box);
  const onChange = vi.fn();
  await act(async () => createRoot(box).render(h(WhoSeesIt, { groups, picked: ["enterprise"], upgrade: null, saving: true, onChange })));
  const beta = box.querySelector<HTMLInputElement>('input[value="beta"]')!;
  // Off, but focusable: the keyboard keeps its place.
  expect(beta.getAttribute("aria-disabled")).toBe("true");
  expect(beta.disabled).toBe(false);
  beta.focus();
  await act(async () => beta.click());
  expect(beta.checked).toBe(false);
  expect(document.activeElement).toBe(beta);
  expect(box.querySelector('input[name="groupsEditable"]')).toBeNull();
  expect(onChange).not.toHaveBeenCalled();
  // Audience too: Everyone isn't taken, and the keyboard stays on it.
  const everyone = box.querySelector<HTMLInputElement>('input[value="everyone"]')!;
  expect(everyone.disabled).toBe(false);
  everyone.focus();
  await act(async () => everyone.click());
  expect(box.querySelector<HTMLInputElement>('input[value="some"]')!.checked).toBe(true);
  expect(document.activeElement).toBe(everyone);
  expect(onChange).not.toHaveBeenCalled();
});

/** Its switches, by their names (the labels they're named by). */
const switchNamed = (box: HTMLElement, name: string) =>
  [...box.querySelectorAll<HTMLInputElement>('input[role="switch"]')].find((input) => input.labels?.[0]?.textContent === name)!;
const lineOf = (input: HTMLInputElement) => document.getElementById(input.getAttribute("aria-describedby") ?? "")?.textContent ?? null;

const entry = {
  number: 7,
  title: "Dark mode",
  content: { type: "doc" as const, content: [] },
  tags: [],
  groups: [],
  posts: [],
  published: false,
  cover: null,
  told: null,
  announced: false,
  emailedSubscribers: false,
  subscribersLeft: 0,
  subscribersSent: 0,
};

test("Audience: Everyone hides the chips; Some groups shows them; going back to Everyone sends no groups, and Some groups again has the picks as they were", async () => {
  const box = document.createElement("form");
  document.body.append(box);
  const onChange = vi.fn();
  await act(async () => createRoot(box).render(h(WhoSeesIt, { groups, picked: [], upgrade: null, onChange })));
  const chips = () => box.querySelector<HTMLInputElement>('input[value="beta"]')!.closest("div")!;
  expect(box.querySelector<HTMLInputElement>('input[value="everyone"]')!.checked).toBe(true);
  expect(chips().hidden).toBe(true);
  await act(async () => box.querySelector<HTMLInputElement>('input[value="some"]')!.click());
  expect(chips().hidden).toBe(false);
  // Only showing the chips is no change to send.
  expect(box.querySelector('input[name="groupsEditable"]')).toBeNull();
  await act(async () => box.querySelector<HTMLInputElement>('input[value="beta"]')!.click());
  expect(new FormData(box).getAll("groups")).toEqual(["beta"]);
  await act(async () => box.querySelector<HTMLInputElement>('input[value="everyone"]')!.click());
  expect(chips().hidden).toBe(true);
  expect(new FormData(box).getAll("groups")).toEqual([]);
  expect(box.querySelector('input[name="groupsEditable"]')).not.toBeNull();
  await act(async () => box.querySelector<HTMLInputElement>('input[value="some"]')!.click());
  expect(new FormData(box).getAll("groups")).toEqual(["beta"]);
});

test("Some groups with none ticked isn't saved (as everyone) or published: the first chip says to pick one, or choose Everyone", async () => {
  const box = document.createElement("form");
  document.body.append(box);
  const Held = () => {
    const saving = useContext(ChangelogSavingContext);
    return h("output", null, `${saving?.groupsChanged} ${saving?.noGroupPicked}`);
  };
  await act(async () => createRoot(box).render(h(ChangelogSaving, null, h(Held), h(WhoSeesIt, { groups, picked: [], upgrade, onChange: () => {} }))));
  expect(box.querySelector("output")?.textContent).toBe("false false");
  expect(box.checkValidity()).toBe(true);
  await act(async () => box.querySelector<HTMLInputElement>('input[value="some"]')!.click());
  expect(box.querySelector("output")?.textContent).toBe("true true");
  expect(box.checkValidity()).toBe(false);
  expect(box.querySelector<HTMLInputElement>('input[name="groups"]')!.validationMessage).toBe("Pick a group, or choose Everyone.");
  // On a plan without groups the pick is refused: still none.
  await act(async () => box.querySelector<HTMLInputElement>('input[value="beta"]')!.click());
  expect(box.checkValidity()).toBe(false);
  await act(async () => box.querySelector<HTMLInputElement>('input[value="everyone"]')!.click());
  expect(box.querySelector("output")?.textContent).toBe("false false");
  expect(box.checkValidity()).toBe(true);
});

test("Some groups with one ticked can be saved; unticked again, it can't", async () => {
  const box = document.createElement("form");
  document.body.append(box);
  await act(async () => createRoot(box).render(h(WhoSeesIt, { groups, picked: [], upgrade: null, onChange: () => {} })));
  await act(async () => box.querySelector<HTMLInputElement>('input[value="some"]')!.click());
  await act(async () => box.querySelector<HTMLInputElement>('input[value="beta"]')!.click());
  expect(box.checkValidity()).toBe(true);
  await act(async () => box.querySelector<HTMLInputElement>('input[value="beta"]')!.click());
  expect(box.checkValidity()).toBe(false);
});

test("an entry saved for some groups opens on Some groups, its chips picked", async () => {
  const box = document.createElement("form");
  document.body.append(box);
  await act(async () => createRoot(box).render(h(WhoSeesIt, { groups, picked: ["beta"], upgrade: null, onChange: () => {} })));
  expect(box.querySelector<HTMLInputElement>('input[value="some"]')!.checked).toBe(true);
  expect(new FormData(box).getAll("groups")).toEqual(["beta"]);
});

test("Goes to: a draft goes to the changelog list, the widget popup and an email announcement, all on to start with", async () => {
  const box = document.createElement("form");
  document.body.append(box);
  await act(async () => createRoot(box).render(h(ChangelogSaving, null, h(WhoSeesIt, { groups: [], picked: [], entry, subscribers: 3, upgrade: null, onChange: () => {} }))));
  for (const name of ["Changelog list", "Widget popup", "Email announcement"]) {
    expect(switchNamed(box, name).checked).toBe(true);
    expect(switchNamed(box, name).disabled).toBe(false);
  }
  expect(lineOf(switchNamed(box, "Email announcement"))).toBe("3 subscribers");
  // No hint lines: the list and the popup have none.
  expect(switchNamed(box, "Changelog list").hasAttribute("aria-describedby")).toBe(false);
  expect(switchNamed(box, "Widget popup").hasAttribute("aria-describedby")).toBe(false);
  // Without groups, there's no Audience.
  expect(box.textContent).not.toContain("Audience");
});

test("a new entry has the changelog list only: the popup and the email are picked once it's saved, for Publish", async () => {
  const box = document.createElement("form");
  document.body.append(box);
  await act(async () => createRoot(box).render(h(ChangelogSaving, null, h(WhoSeesIt, { groups: [], picked: [], upgrade: null, onChange: () => {} }))));
  expect([...box.querySelectorAll('input[role="switch"]')].map((input) => (input as HTMLInputElement).labels?.[0]?.textContent)).toEqual(["Changelog list"]);
});

test("the changelog list off: email only, sent once changed and holding Publish until saved; the popup is off and disabled, and back as it was once the list is on", async () => {
  const box = document.createElement("form");
  document.body.append(box);
  const Held = () => h("output", null, String(useContext(ChangelogSavingContext)?.groupsChanged));
  await act(async () => createRoot(box).render(h(ChangelogSaving, null, h(Held), h(WhoSeesIt, { groups: [], picked: [], entry, subscribers: 3, upgrade: null, onChange: () => {} }))));
  expect(box.querySelector('input[name="emailOnlyEditable"]')).toBeNull();
  await act(async () => switchNamed(box, "Changelog list").click());
  expect(switchNamed(box, "Changelog list").checked).toBe(false);
  expect(new FormData(box).get("emailOnly")).toBe("1");
  expect(new FormData(box).get("emailOnlyEditable")).toBe("1");
  expect(box.querySelector("output")?.textContent).toBe("true");
  const popup = () => switchNamed(box, "Widget popup");
  expect(popup().checked).toBe(false);
  expect(popup().disabled).toBe(true);
  expect(lineOf(popup())).toBe("Needs the changelog list");
  // The email still goes: that's what email only is.
  expect(switchNamed(box, "Email announcement").checked).toBe(true);
  await act(async () => switchNamed(box, "Changelog list").click());
  expect(popup().checked).toBe(true);
  expect(popup().disabled).toBe(false);
  // Back as saved: nothing to send, nothing to hold.
  expect(box.querySelector('input[name="emailOnlyEditable"]')).toBeNull();
  expect(box.querySelector("output")?.textContent).toBe("false");

  // A popup turned off stays off through the list's off and on.
  await act(async () => popup().click());
  await act(async () => switchNamed(box, "Changelog list").click());
  await act(async () => switchNamed(box, "Changelog list").click());
  expect(popup().checked).toBe(false);
});

test("an entry saved as email only opens with the list off, and sends nothing until it changes", async () => {
  const box = document.createElement("form");
  document.body.append(box);
  await act(async () => createRoot(box).render(h(WhoSeesIt, { groups: [], picked: [], emailOnly: true, upgrade: null, onChange: () => {} })));
  expect(switchNamed(box, "Changelog list").checked).toBe(false);
  // Its own value goes only with emailOnlyEditable (changelog.ts reads neither without it).
  expect(new FormData(box).get("emailOnlyEditable")).toBeNull();
});

test("Publish with Email announcement off emails no subscriber", async () => {
  const box = document.createElement("form");
  document.body.append(box);
  await act(async () =>
    createRoot(box).render(
      h(
        ChangelogSaving,
        null,
        h(WhoSeesIt, { groups: [], picked: [], entry, subscribers: 3, upgrade: null, onChange: () => {} }),
        h(ChangelogEntryActions, { projectSlug: "acme", number: 7, title: "Dark mode", published: false, postCount: 0, subscribers: 3, emails: 0, canDraftWithAi: false, part: "publish" }),
      ),
    ),
  );
  await act(async () => switchNamed(box, "Email announcement").click());
  expect(switchNamed(box, "Email announcement").checked).toBe(false);
  const publish = () => [...document.querySelectorAll("button")].filter((button) => button.textContent === "Publish");
  await act(async () => publish()[0].click());
  expect(document.querySelector('[role="alertdialog"]')?.textContent).toContain("It goes on your portal and in your widget.");
  await act(async () => publish().at(-1)!.click());
  expect(publishChangelogEntry).toHaveBeenCalledWith("acme", 7, true, false, undefined);
});
