import { TRPCClientError } from "@trpc/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

import { type Uploader, uploadFile as uploadFileWith, uploadImage as uploadImageWith } from "./upload-image";

const createUpload = vi.fn();
const finishUpload = vi.fn();
const uploadStatus = vi.fn();
/** The uploads.* procedures, as the tRPC client has them. */
const trpc = { uploads: { create: { mutate: createUpload }, finish: { mutate: finishUpload }, status: { query: uploadStatus } } } as unknown as Uploader;
const uploadImage = (slug: string, file: File) => uploadImageWith(trpc, slug, file);
const uploadFile = (slug: string, file: File) => uploadFileWith(trpc, slug, file);
/** The server refusing, as tRPC rejects with it: its message, in its error's shape. */
const refused = (message: string) => new TRPCClientError(message, { result: { error: { message, code: -32600, data: { code: "BAD_REQUEST", httpStatus: 400 } } } });

const image = () => new File(["x"], "screen.png", { type: "image/png" });
const created = { mediaId: "m1", uploadUrl: "https://storage.example/put", contentType: "image/png", name: "screen.png" };
const put = (ok: boolean) => vi.fn(async () => ({ ok }) as Response);

beforeEach(() => {
  createUpload.mockResolvedValue(created);
  finishUpload.mockResolvedValue({});
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
  uploadStatus.mockResolvedValue({ status: "FAILED" });
  expect(await uploadImage("acme", image())).toEqual({ error: "screen.png couldn't be used as an image", reason: "unusable" });
});

test("one still processing once the polls run out is `tooLong`", async () => {
  vi.useFakeTimers();
  uploadStatus.mockResolvedValue({ status: "PROCESSING" });
  const result = uploadImage("acme", image());
  await vi.runAllTimersAsync();
  expect(await result).toEqual({ error: "The image is taking too long. Try again.", reason: "tooLong" });
  expect(uploadStatus).toHaveBeenCalledTimes(60);
});

test("the server's own refusals carry no reason: its words, said as they are", async () => {
  createUpload.mockRejectedValue(refused("Images can be up to 10 MB."));
  expect(await uploadImage("acme", image())).toEqual({ error: "Images can be up to 10 MB." });
  expect(await uploadFile("acme", image())).toEqual({ error: "Images can be up to 10 MB." });
  createUpload.mockResolvedValue(created);
  finishUpload.mockRejectedValue(refused("This file type isn't allowed."));
  expect(await uploadImage("acme", image())).toEqual({ error: "This file type isn't allowed." });
  expect(await uploadFile("acme", image())).toEqual({ error: "This file type isn't allowed." });
});

test("calls that never reached the server reject, so each caller says it in its own words", async () => {
  createUpload.mockRejectedValue(new TRPCClientError("Failed to fetch"));
  await expect(uploadImage("acme", image())).rejects.toThrow("Failed to fetch");
  createUpload.mockResolvedValue(created);
  uploadStatus.mockRejectedValue(new TRPCClientError("Failed to fetch"));
  await expect(uploadImage("acme", image())).rejects.toThrow("Failed to fetch");
});

test("each call names the project it uploads to", async () => {
  uploadStatus.mockResolvedValue({ status: "READY", src: "s", urls: {}, width: 1, height: 1, download: "d" });
  await uploadImage("acme", image());
  expect(createUpload).toHaveBeenCalledWith({ project: "acme", type: "image/png", size: 1 });
  expect(finishUpload).toHaveBeenCalledWith({ project: "acme", mediaId: "m1" });
  expect(uploadStatus).toHaveBeenCalledWith({ project: "acme", mediaId: "m1" });
});
