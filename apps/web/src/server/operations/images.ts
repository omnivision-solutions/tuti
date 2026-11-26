import { imageKey, imageWidths, MAX_IMAGE_SIZE } from "@tuti/content/media";
import { prisma } from "@tuti/db";
import { imagesMeter, OutOfCredits, roomForImage, storeImage } from "@tuti/jobs";
import { aiEnabled, generateImage, imageShape, imagesEnabled, log } from "@tuti/shared";
import { mediaStorage } from "@tuti/shared/storage";
import sharp from "sharp";
import { z } from "zod";

import { lastingImage } from "../media-urls";
import { uploaderOf } from "./changelog";
import { NO_CREDITS } from "./credits";
import { defineOperation, OperationError } from "./define";
import { imageOutput } from "./widget";

/**
 * AI images (docs/plan.md, AI image generator): one image from a prompt and the project's own images, at the size
 * asked, kept as the caller's upload. Not in any content yet: the daily release frees it if nothing ever uses it.
 */

export const MAX_IMAGE_PROMPT = 2000;
export const MAX_IMAGE_REFERENCES = 14;
export const MIN_GENERATED_SIDE = 64;
/** The size references are sent at: enough for the model to work from, a fraction of a full-size one's bytes. */
const REFERENCE_WIDTH = 1600;

const noRoom = () =>
  new OperationError(409, "no_room", "The image can't be kept: this project has no space left for images, or you've uploaded a lot of images in the last hour");

const side = (name: string) =>
  z
    .number({ error: `Give the ${name} in pixels` })
    .int(`Give the ${name} in whole pixels`)
    .min(MIN_GENERATED_SIDE, `The ${name} is at least ${MIN_GENERATED_SIDE} pixels`)
    .max(MAX_IMAGE_SIZE, `The ${name} is at most ${MAX_IMAGE_SIZE.toLocaleString("en")} pixels`);

export const generateImageOperation = defineOperation({
  name: "images.generate",
  title: "Generate an image",
  summary: `Make one image with AI from a prompt, at exactly the size asked, optionally from up to ${MAX_IMAGE_REFERENCES} of the project's images: kept as an upload to use as a cover or in content (one no content uses is deleted after a day or two). Takes 10 to 30 seconds. Needs OpenRouter as the server's AI provider`,
  method: "POST",
  path: "/images/generate",
  scope: "write",
  access: "team",
  errors: [402, 404, 409, 502, 503],
  input: z.object({
    prompt: z
      .string({ error: "Describe the image" })
      .trim()
      .min(1, "Describe the image")
      .max(MAX_IMAGE_PROMPT, `Keep the prompt under ${MAX_IMAGE_PROMPT.toLocaleString("en")} characters`)
      .describe("What the image shows, and how")
      .meta({ examples: ["A friendly robot sorting feedback cards into piles, flat illustration"] }),
    width: side("width").describe(`Its width in pixels, ${MIN_GENERATED_SIDE} to ${MAX_IMAGE_SIZE}`).meta({ examples: [1600] }),
    height: side("height").describe(`Its height in pixels, ${MIN_GENERATED_SIDE} to ${MAX_IMAGE_SIZE}`).meta({ examples: [840] }),
    references: z
      .array(z.string().trim().min(1).max(100))
      .max(MAX_IMAGE_REFERENCES, `Pick at most ${MAX_IMAGE_REFERENCES} images to work from`)
      .optional()
      .describe(`Up to ${MAX_IMAGE_REFERENCES} of the project's uploaded images (their ids) for the AI to work from: the first one to edit, or others as a style or subject`),
  }),
  output: imageOutput.describe("The new image, an upload by the caller"),
  example: { prompt: "A friendly robot sorting feedback cards into piles, flat illustration", width: 1600, height: 840 },
  run: async ({ actor, projectId }, { prompt, width, height, references = [] }) => {
    if (!imagesEnabled()) {
      throw new OperationError(503, "ai_unavailable", aiEnabled() ? "Generating images needs OpenRouter as this server's AI provider" : "AI isn't set up on this server");
    }
    const storage = mediaStorage();
    if (!storage) {
      throw new OperationError(503, "uploads_unavailable", "Uploads aren't set up on this server");
    }
    const ids = [...new Set(references)];
    const found = await prisma.media.findMany({ where: { id: { in: ids }, projectId, status: "READY", filename: null, width: { not: null } }, select: { id: true, width: true } });
    if (found.length < ids.length) {
      throw new OperationError(404, "not_found", "One of the images to work from isn't in this project");
    }
    // Before paying for an image that couldn't be kept (storeImage checks again: only a race between them pays for nothing).
    // The PNG kept is at most its pixels' bytes uncompressed.
    if (!(await roomForImage(projectId, uploaderOf(actor), width * height * 3 + 1024))) {
      throw noRoom();
    }
    const meter = await imagesMeter(projectId).catch((error: unknown) => {
      throw error instanceof OutOfCredits ? new OperationError(402, "no_credits", NO_CREDITS) : error;
    });
    // In the order given: the first is the one an edit starts from.
    const widths = new Map(found.map((media) => [media.id, imageWidths(media.width!).findLast((w) => w <= REFERENCE_WIDTH)!]));
    const sent = await Promise.all(ids.map(async (id) => `data:image/webp;base64,${Buffer.from(await storage.get(imageKey(id, widths.get(id)!))).toString("base64")}`)).catch((error: unknown) => {
      log.warn("Reading an AI image's references failed", { projectId, error });
      throw new OperationError(503, "copy_failed", "Couldn't read the images to work from just now: try again in a moment");
    });

    const { aspectRatio, imageSize, cropped } = imageShape(width, height);
    let png: Buffer;
    try {
      const made = await generateImage({
        prompt: cropped ? `${prompt}\n\nKeep anything important away from the ${cropped} edges: they will be cropped off.` : prompt,
        references: sent,
        aspectRatio,
        imageSize,
        meter,
      });
      // Centre-cropped to the size's shape, then scaled to it exactly.
      png = await sharp(made).resize(width, height, { fit: "cover", position: "centre" }).png().toBuffer();
    } catch (error) {
      log.warn("AI image failed", { projectId, error });
      throw new OperationError(502, "ai_failed", "The AI couldn't make the image. Try again in a moment.");
    }

    const stored = await storeImage(png, { projectId, uploaderId: uploaderOf(actor) });
    if (!("mediaId" in stored)) {
      throw stored.leftOut === "quota"
        ? noRoom()
        : new OperationError(503, "copy_failed", "Couldn't keep the image just now: try again in a moment");
    }
    return lastingImage({ id: stored.mediaId, status: "READY", width: stored.width, height: stored.height })!;
  },
});
