import { afterEach, expect, test, vi } from "vitest";

import { intercom, IntercomError } from "./intercom";

afterEach(() => vi.unstubAllGlobals());

/** fetch answering 401 everywhere but `region`'s address, recording where it was asked. */
function regions(region: string | null) {
  const asked: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: URL) => {
      asked.push(url.origin);
      return url.origin === region
        ? Response.json({ type: "admin", id: "1" })
        : Response.json({ type: "error.list", errors: [{ code: "unauthorized", message: "Access Token Invalid" }] }, { status: 401 });
    }),
  );
  return asked;
}

test("a token is tried at each region's address till one takes it, which is then kept; one none takes is refused", async () => {
  const asked = regions("https://api.eu.intercom.io");
  const api = intercom("token");
  await expect(api.get("/me")).resolves.toMatchObject({ id: "1" });
  await api.get("/admins");
  expect(asked).toEqual(["https://api.intercom.io", "https://api.eu.intercom.io", "https://api.eu.intercom.io"]);

  const nowhere = regions(null);
  const error = await intercom("bad").get("/me").catch((e: unknown) => e);
  expect(error).toBeInstanceOf(IntercomError);
  expect(error).toMatchObject({ status: 401, message: "Access Token Invalid" });
  expect(nowhere).toEqual(["https://api.intercom.io", "https://api.eu.intercom.io", "https://api.au.intercom.io"]);
});
