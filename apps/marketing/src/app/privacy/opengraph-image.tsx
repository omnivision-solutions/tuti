import { shareImage } from "../../og/og";

export { size } from "../../og/og";
export const contentType = "image/png";
export const alt = "Tuti's Privacy Policy.";

export default function Image() {
  return shareImage({ eyebrow: "Legal", headline: "Privacy Policy", line: "What Tuti collects, why, and your choices." });
}
