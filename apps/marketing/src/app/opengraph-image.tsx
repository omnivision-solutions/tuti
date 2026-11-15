import { MergeVisual, shareImage } from "../og/og";

export { size } from "../og/og";
export const contentType = "image/png";
export const alt = "Ship code. Your help center keeps up. A merged pull request updates an article, completes a feature request and drafts a changelog entry.";

export default function Image() {
  return shareImage({ headline: "Ship code.", accent: "Your help center keeps up.", line: "Open-source help center, AI answers and feedback board.", visual: <MergeVisual /> });
}
