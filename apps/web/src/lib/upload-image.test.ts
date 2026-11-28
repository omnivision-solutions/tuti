import { afterEach, beforeEach, expect, test, vi } from "vitest";

vi.mock("@/server/media", () => ({ createUpload: vi.fn(), finishUpload: vi.fn(), uploadStatus: vi.fn() }));

const { createUpload, finishUpload, uploadStatus } = await import("@/server/media");
const { uploadFile, uploadImage } = await import("./upload-image");

const image = () => new File(["x"], "screen.png", { type: "image/png" });
const created = { mediaId: "m1", uploadUrl: "https://storage.example/put", contentType: "image/png", name: "screen.png" };
const put = (ok: boolean) => vi.fn(async () => ({ ok }) as Response);

beforeEach(() => {
  vi.mocked(createUpload).mockResolvedValue(created as never);
  vi.mocked(finishUpload).mockResolvedValue({} as never);
  vi.stubGlobal("fetch", put(true));
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  vi.resetAllMocks();
});

test("the upload to storage failing is the browser's own failure (`failed`), for images and files alike", async () => {
  vi.stubGlobal("fetch", put(false));
  expect(await uploadImage("acme", image())).toEqual({ error: "The upload failed. Try again.", reason: "failed" });
  expect(await uploadFile("acme", image())).toEqual({ error: "The upload failed. Try again.", reason: "failed" });
  // Offline: the same.
  vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(new TypeError("offline"))));
  expect(await uploadImage("acme", image())).toMatchObject({ reason: "failed" });
});

test("an image the server couldn't use is `unusable`, named", async () => {
  vi.mocked(uploadStatus).mockResolvedValue({ status: "FAILED" } as never);
  expect(await uploadImage("acme", image())).toEqual({ error: "screen.png couldn't be used as an image", reason: "unusable" });
});

test("one still processing once the polls run out is `tooLong`", async () => {
  vi.useFakeTimers();
  vi.mocked(uploadStatus).mockResolvedValue({ status: "PROCESSING" } as never);
  const result = uploadImage("acme", image());
  await vi.runAllTimersAsync();
  expect(await result).toEqual({ error: "The image is taking too long. Try again.", reason: "tooLong" });
  expect(uploadStatus).toHaveBeenCalledTimes(60);
});

test("the server's own refusals carry no reason: its words, said as they are", async () => {
  vi.mocked(createUpload).mockResolvedValue({ error: "Images can be up to 10 MB." } as never);
  expect(await uploadImage("acme", image())).toEqual({ error: "Images can be up to 10 MB." });
  expect(await uploadFile("acme", image())).toEqual({ error: "Images can be up to 10 MB." });
  vi.mocked(createUpload).mockResolvedValue(created as never);
  vi.mocked(finishUpload).mockResolvedValue({ error: "This file type isn't allowed." } as never);
  expect(await uploadImage("acme", image())).toEqual({ error: "This file type isn't allowed." });
  expect(await uploadFile("acme", image())).toEqual({ error: "This file type isn't allowed." });
});
