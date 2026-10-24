// Downloads the app's and the portals' fonts into apps/web/src/fonts (committed), so builds don't
// fetch them from Google Fonts: one failed request there failed the whole build. The same files
// next/font/google asked for: the latin subset, variable where it was variable. Each family's
// licence (all are SIL Open Font License) goes with it, from the google/fonts repository.
// Run it again after adding a font here: `node scripts/fetch-fonts.mjs`.
import { mkdirSync, writeFileSync } from "node:fs";

const OUT = new URL("../apps/web/src/fonts/", import.meta.url);
// A browser's user agent, so the CSS lists woff2 files.
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36";

// [family, Google Fonts axes (css2 syntax), google/fonts directory]
const FONTS = [
  ["Figtree", "wght@300..900", "figtree"],
  ["Bricolage Grotesque", "opsz,wght@12..96,200..800", "bricolagegrotesque"],
  ["Geist Mono", "wght@100..900", "geistmono"],
  ["Inter", "wght@100..900", "inter"],
  ["Roboto", "wght@100..900", "roboto"],
  ["Open Sans", "wght@300..800", "opensans"],
  ["Lato", "wght@400;700", "lato"],
  ["Montserrat", "wght@100..900", "montserrat"],
  ["Poppins", "wght@400;500;600;700", "poppins"],
  ["Source Sans 3", "wght@200..900", "sourcesans3"],
  ["Nunito", "wght@200..1000", "nunito"],
  ["Work Sans", "wght@100..900", "worksans"],
  ["DM Sans", "wght@100..1000", "dmsans"],
  ["Manrope", "wght@200..800", "manrope"],
  ["IBM Plex Sans", "wght@400;500;600;700", "ibmplexsans"],
  ["Space Grotesk", "wght@300..700", "spacegrotesk"],
  ["Merriweather", "wght@400;700", "merriweather"],
  ["Lora", "wght@400..700", "lora"],
  ["Playfair Display", "wght@400..900", "playfairdisplay"],
];

async function get(url, as = "text") {
  const response = await fetch(url, { headers: { "user-agent": UA } });
  if (!response.ok) {
    throw new Error(`${url}: ${response.status}`);
  }
  return as === "text" ? response.text() : Buffer.from(await response.arrayBuffer());
}

mkdirSync(OUT, { recursive: true });
for (const [family, axes, dir] of FONTS) {
  const name = family.toLowerCase().replaceAll(" ", "-");
  const css = await get(`https://fonts.googleapis.com/css2?family=${family.replaceAll(" ", "+")}:${axes}&display=swap`);
  // One @font-face per weight (or one for the whole range), each subset after its comment.
  const faces = [...css.matchAll(/\/\* latin \*\/\s*@font-face\s*{([^}]*)}/g)].map(([, body]) => ({
    weight: body.match(/font-weight:\s*([^;]+);/)[1].trim(),
    url: body.match(/url\(([^)]+)\)/)[1],
  }));
  if (faces.length === 0) {
    throw new Error(`${family}: no latin subset`);
  }
  for (const { weight, url } of faces) {
    const file = faces.length === 1 ? `${name}.woff2` : `${name}-${weight}.woff2`;
    writeFileSync(new URL(file, OUT), await get(url, "buffer"));
    console.log(file, weight);
  }
  writeFileSync(new URL(`${name}.OFL.txt`, OUT), await get(`https://raw.githubusercontent.com/google/fonts/main/ofl/${dir}/OFL.txt`));
}
