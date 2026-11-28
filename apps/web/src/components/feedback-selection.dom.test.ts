// @vitest-environment happy-dom
import { TRPCClientError } from "@trpc/client";
import { act, createElement as h } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

const update = vi.fn();
// One client for the page, as the provider's.
const client = { posts: { update: { mutate: update } } };
const refresh = vi.fn();
const toast = vi.hoisted(() => Object.assign(vi.fn(), { error: vi.fn(), success: vi.fn() }));
vi.mock("@/components/trpc", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/components/trpc")>()), useTRPCClient: () => client }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh }) }));
vi.mock("sonner", () => ({ toast }));

const { FeedbackBulk, FeedbackSelection, SelectPost } = await import("./feedback-selection");

beforeEach(() => vi.clearAllMocks());
afterEach(() => document.body.replaceChildren());

const posts = [1, 2].map((number) => ({ id: `p${number}`, number, title: `Idea ${number}`, voteCount: 0, emails: {}, sample: false }));
/** What the router says when it refuses a post, as /api/trpc answers. */
const refused = (message: string) => new TRPCClientError(message, { result: { error: { message, code: -32600, data: { code: "CONFLICT", httpStatus: 409 } } } });

test("picked posts moved to a board go through posts.update one by one; one refused says which and why, the rest still go", async () => {
  const root = createRoot(document.body.appendChild(document.createElement("div")));
  await act(async () =>
    root.render(
      h(
        FeedbackSelection,
        // (Their props type their children as required: they're the third argument here.)
        { listKey: "all", listed: posts } as never,
        h(FeedbackBulk, { projectSlug: "acme", boards: [{ slug: "bugs", name: "Bugs" }] } as never, h("header", null, h("div"))),
        posts.map((post) => h(SelectPost, { key: post.id, post })),
      ),
    ),
  );
  for (const box of document.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')) {
    await act(async () => box.click());
  }
  update.mockResolvedValueOnce({}).mockRejectedValueOnce(refused("This post was merged into another one"));
  await act(async () => document.querySelector<HTMLElement>('[aria-label="Move to board"]')!.click());
  await act(async () => [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((item) => item.textContent === "Bugs")!.click());
  expect(update.mock.calls).toEqual([[{ project: "acme", number: 1, board: "bugs" }], [{ project: "acme", number: 2, board: "bugs" }]]);
  expect(toast.error).toHaveBeenCalledWith("1 of 2 done. #2: This post was merged into another one");
  // The list again, once, with none picked.
  expect(refresh).toHaveBeenCalledTimes(1);
  await act(async () => root.unmount());
});
