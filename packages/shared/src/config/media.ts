import { z } from "zod";

const mb = (value: number, description: string) => z.number().positive().describe(description).default(value);

/**
 * Uploads: the largest of each kind, and all of a project's together, in megabytes. An import's images come from another
 * tool, uncompressed as often as not, and are re-encoded to WebP before they're kept (packages/jobs images.ts), so they
 * may be larger going in: as large as a file, so a copy takes no more memory than an attachment does. sharp's pixel
 * limit still applies.
 */
export const media = z
  .strictObject({
    maxMb: z
      .strictObject({
        teamImage: mb(10, "An image the team uploads, in megabytes"),
        userImage: mb(5, "An image a reader uploads (to a post, a comment or a message), in megabytes"),
        importImage: mb(25, "An image an import copies from another tool, before it's re-encoded, in megabytes"),
        teamFile: mb(25, "A file the team attaches to an article, in megabytes"),
        teamVideo: mb(200, "A video the team uploads, in megabytes"),
      })
      .prefault({}),
    projectQuotaMb: mb(1024, "All of a project's uploads together, in megabytes"),
  })
  .prefault({});

/** The variables this section replaced: setting one stops start-up (checkConfig). */
export const MEDIA_REPLACED = {
  MEDIA_MAX_IMAGE_MB_TEAM: "media.maxMb.teamImage",
  MEDIA_MAX_IMAGE_MB_USER: "media.maxMb.userImage",
  MEDIA_MAX_IMPORT_IMAGE_MB: "media.maxMb.importImage",
  MEDIA_MAX_FILE_MB_TEAM: "media.maxMb.teamFile",
  MEDIA_MAX_VIDEO_MB_TEAM: "media.maxMb.teamVideo",
  MEDIA_PROJECT_QUOTA_MB: "media.projectQuotaMb",
};
