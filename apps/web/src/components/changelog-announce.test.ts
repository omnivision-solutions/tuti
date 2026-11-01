import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test, vi } from "vitest";

vi.mock("@/server/changelog", () => ({}));
vi.mock("@/server/branding", () => ({}));
vi.mock("@/server/widget", () => ({}));
vi.mock("@/server/media", () => ({}));

const { HowAnnounced, publishSummary } = await import("./changelog");

/** "How it's announced" in an entry's sidebar, as text. */
const sidebar = (entry: { published: boolean; emailedSubscribers: boolean; subscribersLeft: number }, subscribers: number | null = 3) =>
  renderToStaticMarkup(
    createElement(HowAnnounced, {
      entry: { number: 1, title: "Dark mode", content: { type: "doc", content: [] }, tags: [], posts: [], cover: null, told: null, announced: true, ...entry },
      subscribers,
    }),
  )
    .replace(/<[^>]+>/g, " ")
    .replaceAll("&#x27;", "'")
    .replace(/\s+/g, " ")
    .trim();

describe("an entry emailed to some of its subscribers, not all (held, or unpublished before they all went)", () => {
  test("its draft says publishing sends it to those who haven't had it yet", () => {
    expect(sidebar({ published: false, emailedSubscribers: true, subscribersLeft: 300 })).toContain(
      "Publishing sends it to the 300 subscribers who haven't had it yet.",
    );
    expect(sidebar({ published: false, emailedSubscribers: true, subscribersLeft: 1 })).toContain(
      "Publishing sends it to the subscriber who hasn't had it yet.",
    );
    expect(publishSummary({ markNew: true, email: true, subscribers: 500, emailedSubscribers: true, subscribersLeft: 300 })).toBe(
      "It appears on your portal's changelog, marked new in your widget, and it's sent to the 300 subscribers who haven't had it yet.",
    );
  });

  test("published, it says some are still to go", () => {
    expect(sidebar({ published: true, emailedSubscribers: true, subscribersLeft: 300 })).toContain("Being emailed to subscribers: 300 still to go.");
  });

  test("all sent: publishing again emails nobody, and says so", () => {
    expect(sidebar({ published: false, emailedSubscribers: true, subscribersLeft: 0 })).toContain(
      "Emailed to subscribers when it was first published: it isn't sent again.",
    );
    expect(publishSummary({ markNew: false, email: true, subscribers: 500, emailedSubscribers: true, subscribersLeft: 0 })).toBe(
      "It appears on your portal's changelog.",
    );
    expect(publishSummary({ markNew: true, email: true, subscribers: 2, emailedSubscribers: false, subscribersLeft: 0 })).toBe(
      "It appears on your portal's changelog, marked new in your widget, and it's emailed to your 2 subscribers.",
    );
  });

  test("on a portal gone private (nobody's left to email: subscribersLeft is 0 there), the draft says the rest won't get it", () => {
    expect(sidebar({ published: false, emailedSubscribers: true, subscribersLeft: 0 }, null)).toContain(
      "Your portal is private now: it isn't emailed to anyone else.",
    );
  });
});
