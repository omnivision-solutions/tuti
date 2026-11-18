import { expect, test } from "vitest";

import { widgetSourceHref } from "./widget-docs";

test("an answer's article source opens in the widget's Help center; an API operation's, which the panel can't show, on its page", () => {
  expect(widgetSourceHref("inviting-your-team")).toBe("/widget?tab=docs&article=inviting-your-team");
  expect(widgetSourceHref("reference/create-a-post")).toBeNull();
});
