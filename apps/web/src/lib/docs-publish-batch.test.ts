import { expect, it, vi } from "vitest";
import { publishBatch } from "./docs-publish-batch";

it("keeps earlier successes and stops further requests when publishing throws", async () => {
  const publish = vi.fn().mockResolvedValueOnce({}).mockRejectedValueOnce(new Error("Connection dropped"));
  expect(await publishBatch(["first", "unreachable", "unattempted"], publish)).toEqual({
    published: ["first"],
    failed: [
      { article: "unreachable", error: "Couldn't reach the server", code: "unreachable" },
      { article: "unattempted", error: "Not attempted: Couldn't reach the server", code: "unreachable" },
    ],
  });
  expect(publish.mock.calls).toEqual([["first"], ["unreachable"]]);
});

it("continues after a deleted article or review hold and records what went live", async () => {
  const publish = vi.fn()
    .mockResolvedValueOnce({})
    .mockResolvedValueOnce({ error: "Article was deleted", code: "not_found" })
    .mockResolvedValueOnce({ error: "Review the edit", code: "edits_required" })
    .mockResolvedValueOnce({});
  expect(await publishBatch(["first", "deleted", "held", "last"], publish)).toEqual({
    published: ["first", "last"],
    failed: [
      { article: "deleted", error: "Article was deleted", code: "not_found" },
      { article: "held", error: "Review the edit", code: "edits_required" },
    ],
  });
  expect(publish.mock.calls).toEqual([["first"], ["deleted"], ["held"], ["last"]]);
});

it.each(["article_limit", "forbidden", "unauthorized"])("stops on %s and accounts for successes and unattempted articles", async (code) => {
  const publish = vi.fn().mockResolvedValueOnce({}).mockResolvedValueOnce({ error: "Publishing is unavailable", code });
  expect(await publishBatch(["first", "refused", "unattempted"], publish)).toEqual({
    published: ["first"],
    failed: [
      { article: "refused", error: "Publishing is unavailable", code },
      { article: "unattempted", error: "Not attempted: Publishing is unavailable", code },
    ],
  });
  expect(publish.mock.calls).toEqual([["first"], ["refused"]]);
});
