"use server";

import type { LastingImage } from "./media-urls";
import { generateImageOperation } from "./operations/images";
import { asTeam, call } from "./operations/run";

/** AI images (images.generate) for the app's editors. */

/** Makes one image with AI and keeps it as the signed-in teammate's upload: the image, or `error` saying why not. */
export async function generateImage(
  projectSlug: string,
  input: { prompt: string; width: number; height: number; references?: string[] },
): Promise<{ error?: string; image?: LastingImage }> {
  let image: LastingImage | undefined;
  const result = await asTeam(projectSlug, "Only the project's team can make images", async (context) => {
    image = await call(generateImageOperation, context, {
      // As sent: the operation's own schema refuses what isn't a prompt, a size or ids (a missing prompt isn't "undefined").
      prompt: input.prompt,
      width: input.width,
      height: input.height,
      references: input.references,
    });
  });
  return image ? { image } : result;
}
