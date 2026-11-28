import type { MediaUrls } from "@tuti/content";
import { type TRPCClient, TRPCClientError } from "@trpc/client";

import type { AppRouter } from "@/server/trpc/router";

/** The tRPC client a component has (useTRPCClient): uploads go through the uploads.* procedures. */
export type Uploader = TRPCClient<AppRouter>;

/** The server's refusal as the `{ error }` callers show, in its words; anything else (offline) rejects, as the callers expect. */
async function said<T>(call: Promise<T>): Promise<T | { error: string }> {
  return call.catch((error: unknown) => {
    if (error instanceof TRPCClientError && error.shape) {
      return { error: error.message };
    }
    throw error;
  });
}

/**
 * Why an upload failed here in the browser (not the server's words), so a page can say it in its language: the upload
 * itself, an image the server couldn't use, or one it took too long with. `error` is the same in English.
 */
export type UploadFailure = { error: string; reason?: "failed" | "unusable" | "tooLong" };

/** Uploads straight to media storage, then waits until the image is processed. */
export async function uploadImage(
  trpc: Uploader,
  projectSlug: string,
  file: File,
): Promise<{ mediaId: string; src: string; urls: MediaUrls; w: number; h: number } | UploadFailure> {
  const created = await said(trpc.uploads.create.mutate({ project: projectSlug, type: file.type, size: file.size }));
  if ("error" in created) {
    return created;
  }
  const put = await fetch(created.uploadUrl, { method: "PUT", body: file, headers: { "content-type": file.type } }).catch(
    () => null,
  );
  if (!put?.ok) {
    return { error: "The upload failed. Try again.", reason: "failed" };
  }
  const finished = await said(trpc.uploads.finish.mutate({ project: projectSlug, mediaId: created.mediaId }));
  if ("error" in finished) {
    return finished;
  }
  for (let attempt = 0; attempt < 60; attempt++) {
    const status = await said(trpc.uploads.status.query({ project: projectSlug, mediaId: created.mediaId }));
    if ("error" in status) {
      return status;
    }
    if (status.status === "READY") {
      return { mediaId: created.mediaId, src: status.src, urls: status.urls, w: status.width, h: status.height };
    }
    if (status.status === "FAILED") {
      return { error: `${file.name} couldn't be used as an image`, reason: "unusable" };
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  return { error: "The image is taking too long. Try again.", reason: "tooLong" };
}

/** Uploads a file attachment or a video (articles) straight to media storage; it's ready once the server has checked it. A video has its `src`. */
export async function uploadFile(trpc: Uploader, projectSlug: string, file: File): Promise<{ mediaId: string; name: string; size: number; src?: string } | UploadFailure> {
  const created = await said(trpc.uploads.create.mutate({ project: projectSlug, name: file.name, type: file.type, size: file.size }));
  if ("error" in created) {
    return created;
  }
  const put = await fetch(created.uploadUrl, { method: "PUT", body: file, headers: { "content-type": created.contentType } }).catch(
    () => null,
  );
  if (!put?.ok) {
    return { error: "The upload failed. Try again.", reason: "failed" };
  }
  const finished = await said(trpc.uploads.finish.mutate({ project: projectSlug, mediaId: created.mediaId }));
  return "error" in finished ? finished : { mediaId: created.mediaId, name: created.name ?? file.name, size: file.size, src: finished.src };
}
