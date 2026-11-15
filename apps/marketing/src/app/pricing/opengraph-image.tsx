import { shareImage, WindowVisual } from "../../og/og";

export { size } from "../../og/og";
export const contentType = "image/png";
export const alt = "Tuti pricing: simple pricing, per project.";

export default function Image() {
  return shareImage({
    eyebrow: "Pricing",
    headline: "Simple pricing,",
    accent: "per project.",
    line: "Never per seat or per end user.",
    visual: (
      <WindowVisual
        url="tuti.so/pricing"
        rows={[
          { text: "Per project", pill: ["Yes", "done"] },
          { text: "Per seat", pill: ["Never", "open"] },
          { text: "Per end user", pill: ["Never", "open"] },
          { text: "Self-hosted", pill: ["Free", "done"] },
        ]}
      />
    ),
  });
}
