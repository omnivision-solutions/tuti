// @vitest-environment happy-dom
import { act, createElement as h, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, test, vi } from "vitest";

import { TrpcProvider, useTRPCClient } from "@/components/trpc";
import { PAGE_LANGUAGE_HEADER } from "@/lib/language-addresses";

/** The app's tRPC client says the page's language on a language's address (a save there keeps it as the reader's). */

const roots: Root[] = [];
afterEach(async () => {
  await act(async () => roots.splice(0).forEach((root) => root.unmount()));
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

/** The headers of the call a portal page at `path` sends (a vote, through the batch link, and as the widget's person). */
async function sentFrom(path: string, widget = false, base = ""): Promise<Headers> {
  window.history.replaceState(null, "", path);
  const fetch = vi.fn(async () => Response.json(widget ? { result: { data: { json: {} } } } : [{ result: { data: { json: {} } } }]));
  vi.stubGlobal("fetch", fetch);
  const Vote = () => {
    const client = useTRPCClient();
    useEffect(() => {
      void client.votes.set.mutate({ project: "acme", number: 1, voted: true }, widget ? { context: { authorization: "Widget a-token" } } : undefined);
    }, [client]);
    return null;
  };
  const root = createRoot(document.body.appendChild(document.createElement("div")));
  roots.push(root);
  await act(async () => root.render(h(TrpcProvider, { base, children: h(Vote) })));
  await vi.waitFor(() => expect(fetch).toHaveBeenCalled());
  const [, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
  return new Headers(init.headers);
}

test("a call from a language's address says its language; from the default address, or the app's, none", async () => {
  expect((await sentFrom("/de/feedback/ideas/dark-mode-1")).get(PAGE_LANGUAGE_HEADER)).toBe("de");
  expect((await sentFrom("/pt-br")).get(PAGE_LANGUAGE_HEADER)).toBe("pt-BR");
  expect((await sentFrom("/feedback/ideas/dark-mode-1")).has(PAGE_LANGUAGE_HEADER)).toBe(false);
  expect((await sentFrom("/app/acme/feedback")).has(PAGE_LANGUAGE_HEADER)).toBe(false);
  // A portal under a path of the team's site: the language after its path.
  expect((await sentFrom("/portal/de/roadmap", false, "/portal")).get(PAGE_LANGUAGE_HEADER)).toBe("de");
});

test("the widget's person's call (its own Authorization, sent on its own) says the page's language too", async () => {
  const headers = await sentFrom("/de/widget", true);
  expect([headers.get(PAGE_LANGUAGE_HEADER), headers.get("authorization")]).toEqual(["de", "Widget a-token"]);
});
