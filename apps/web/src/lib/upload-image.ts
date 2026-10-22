import type { MediaUrls } from "@tuti/content";

import { createUpload, finishUpload, uploadStatus } from "@/server/media";

/** Uploads straight to media storage, then waits until the image is processed. */
export async function uploadImage(
  projectSlug: string,
  file: File,
): Promise<{ mediaId: string; src: string; urls: MediaUrls; w: number; h: number } | { error: string }> {
  const created = await createUpload(projectSlug, { type: file.type, size: file.size });
  if ("error" in created) {
    return created;
  }
  const put = await fetch(created.uploadUrl, { method: "PUT", body: file, headers: { "content-type": file.type } }).catch(
    () => null,
  );
  if (!put?.ok) {
    return { error: "The upload failed. Try again." };
  }
  const finished = await finishUpload(created.mediaId);
  if (finished.error) {
    return { error: finished.error };
  }
  for (let attempt = 0; attempt < 60; attempt++) {
    const status = await uploadStatus(created.mediaId);
    if ("error" in status) {
      return status;
    }
    if (status.status === "READY") {
      return { mediaId: created.mediaId, src: status.src, urls: status.urls, w: status.width, h: status.height };
    }
    if (status.status === "FAILED") {
      return { error: `${file.name} couldn't be used as an image` };
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  return { error: "The image is taking too long. Try again." };
}
