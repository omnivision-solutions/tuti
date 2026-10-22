/**
 * next/font/google under Vitest (vitest.config.ts aliases it here): Next.js compiles its loaders when
 * the app is built, so tests get what the app reads from a font instead, a class and its variable.
 */
type Options = { variable?: string };
const font = (options: Options = {}) => ({ className: "font", variable: options.variable ?? "", style: { fontFamily: "font" } });

export const Bricolage_Grotesque = font;
export const DM_Sans = font;
export const Figtree = font;
export const Geist_Mono = font;
export const IBM_Plex_Sans = font;
export const Inter = font;
export const Lato = font;
export const Lora = font;
export const Manrope = font;
export const Merriweather = font;
export const Montserrat = font;
export const Nunito = font;
export const Open_Sans = font;
export const Playfair_Display = font;
export const Poppins = font;
export const Roboto = font;
export const Source_Sans_3 = font;
export const Space_Grotesk = font;
export const Work_Sans = font;
