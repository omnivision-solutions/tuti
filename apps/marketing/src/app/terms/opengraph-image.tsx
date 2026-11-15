import { shareImage } from "../../og/og";

export { size } from "../../og/og";
export const contentType = "image/png";
export const alt = "Tuti's Terms of Service.";

export default function Image() {
  return shareImage({ eyebrow: "Legal", headline: "Terms of Service", line: "The terms for using Tuti's hosted service." });
}
