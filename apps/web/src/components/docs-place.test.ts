import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, test, vi } from "vitest";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => {} }) }));
vi.mock("@/server/docs", () => ({}));

// Its imports reach the server's settings.
vi.stubEnv("APP_URL", "https://tuti.example");
vi.stubEnv("PORTAL_URL_TEMPLATE", "https://{project}.tuti.example");
const { PlaceFields } = await import("./docs");

/** The fields an article's place sends, by name. */
const sent = (props: Parameters<typeof PlaceFields>[0]) =>
  Object.fromEntries([...renderToStaticMarkup(createElement(PlaceFields, props)).matchAll(/name="(\w+)" value="([^"]*)"/g)].map((m) => [m[1], m[2]]));

const loaded = { collection: "basics", showUpdatedDate: true };

test("a saved article's panel sends only what changed since it opened, so a newer move by someone else stays", () => {
  expect(sent({ place: loaded, loaded })).toEqual({});
  expect(sent({ place: { ...loaded, collection: null }, loaded })).toEqual({ collection: "" });
  expect(sent({ place: { ...loaded, showUpdatedDate: false }, loaded })).toEqual({ showUpdatedDate: "off" });
});

test("a new article's sends both", () => {
  expect(sent({ place: loaded })).toEqual({ collection: "basics", showUpdatedDate: "on" });
});
