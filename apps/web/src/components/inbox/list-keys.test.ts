// @vitest-environment happy-dom
import { act, createElement as h } from "react";
import { createRoot } from "react-dom/client";
import { expect, test, vi } from "vitest";

const router = vi.hoisted(() => ({ replace: vi.fn(), refresh: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => router }));

const { actOn, ListKeys, refreshAfterAction } = await import("./list-keys");
const { INBOX_REFRESH_COOKIE } = await import("@/lib/inbox-details");

/** The list as its page renders it: these conversations' rows, and the latest action's refresh it was rendered with. */
const list = (numbers: number[], refreshed: number) =>
  h(ListKeys, {
    place: "acme:spam",
    open: 1,
    none: "/app/acme/inbox?view=spam",
    refreshed,
    "aria-label": "Conversations",
    children: h("ul", null, ...numbers.map((n) => h("li", { key: n }, h("a", { href: `/app/acme/inbox/${n}?view=spam`, "data-row-link": n }, `#${n}`)))),
  });

// tRPC calls run side by side: a refresh asked for before the action (the live one, say) can land after it with the
// list as it was. Seen in CI: the open one stayed open after Not spam took it out of Spam.
test("the open one acted on moves on at its action's refresh, not at an earlier one's that lands after the action", async () => {
  const root = createRoot(document.body.appendChild(document.createElement("div")));
  await act(async () => root.render(list([1, 2, 3], 0)));

  const moved = actOn(1, true);
  refreshAfterAction(router);
  moved();
  const refreshed = Number(document.cookie.match(new RegExp(`${INBOX_REFRESH_COOKIE}=(\\d+)`))![1]);
  expect(router.refresh).toHaveBeenCalledOnce();

  // The earlier refresh: still listed, rendered before the action's refresh was asked for.
  await act(async () => root.render(list([1, 2, 3], 0)));
  expect(router.replace).not.toHaveBeenCalled();
  // The action's: gone from the list, the next one down opens.
  await act(async () => root.render(list([2, 3], refreshed)));
  expect(router.replace).toHaveBeenCalledWith(expect.stringMatching(/\/app\/acme\/inbox\/2\?view=spam$/), { scroll: false });
});
