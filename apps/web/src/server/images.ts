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
      prompt: String(input.prompt),
      width: Number(input.width),
      height: Number(input.height),
      references: input.references?.map(String),
    });
  });
  return image ? { image } : result;
}
