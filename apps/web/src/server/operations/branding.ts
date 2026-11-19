import { prisma } from "@tuti/db";
import { plansEnabled } from "@tuti/shared";
import { z } from "zod";

import { attachMedia, MEDIA_GONE } from "../content";
import { badgeLicensed, installation as thisInstallation, poweredByShown } from "../license";
import { type LastingImage, lastingImage, shareImage } from "../media-urls";
import { isPortalFont, PORTAL_FONTS, type PortalFont } from "@/lib/portal-fonts";
import {
  COLOR_SCHEMES,
  type ColorScheme,
  CUSTOM_CODE_MAX,
  type ContentActions,
  DOCS_SUBTITLE_MAX,
  DOCS_TITLE_MAX,
  type DocsHome,
  LOGO_TEXT_MAX,
} from "@/lib/portal-look";

import { saving } from "./create";
import { defineOperation, OperationError } from "./define";
import { DEFAULT_WIDGET_COLOR, hexColor, httpsLink, imageOutput, linkOutput, type WidgetLink } from "./widget";

/**
 * The portal's and its docs' look (Phase 10, Customize): logos, favicon, accent colour, header and
 * footer links, "Powered by", what readers can do with an article, the docs' home, the default colour
 * scheme, the logo's text and link, links above the docs' tree, and the
 * portal's search listing (SEO).
 */

export const SEO_TITLE_MAX = 70;
export const SEO_DESCRIPTION_MAX = 160;

export const MAX_BRAND_LINKS = 5;

/** Where each image's upload id is stored. */
const IMAGES = { logo: "brandLogoId", logoDark: "brandLogoDarkId", favicon: "brandFaviconId", seoImage: "seoImageId" } as const;
type ImageName = keyof typeof IMAGES;

export type BrandImage = LastingImage;
export type Branding = {
  logo: BrandImage | null;
  /** Shown instead of `logo` in dark mode; without it the logo shows in both. */
  logoDark: BrandImage | null;
  favicon: BrandImage | null;
  /** `#rrggbb`, or null for the brand green. */
  color: string | null;
  headerLinks: WidgetLink[];
  footerLinks: WidgetLink[];
  /** Whether the footer says "Powered by tuti": always, unless the project has a valid licence key. */
  poweredBy: boolean;
  contentActions: ContentActions;
  docsHome: DocsHome;
  colorScheme: ColorScheme;
  /** Whether readers get a light/dark switch in the portal's footer; off, every reader gets `colorScheme` (under a path of the team's site, a theme the site keeps stays). */
  themeSwitch: boolean;
  /** Beside the logo (empty: none; without a logo, the project's name shows). */
  logoText: string;
  /** Where the logo goes; null for the portal's home. */
  logoLink: string | null;
  /** Above the docs' tree. */
  sidebarLinks: WidgetLink[];
  /** How the portal shows in search results and where it's shared: its title (empty: the project's name) and description. */
  seo: { title: string; description: string };
  /** The image a link to the portal shows (Open Graph); null for none. */
  seoImage: BrandImage | null;
  /** For headings and for text, from the portal fonts; null for the page's own. */
  fonts: { heading: PortalFont | null; body: PortalFont | null };
  /** The team's CSS, on every portal page. */
  customCss: string;
  /** The team's HTML at the end of the page, only where the portal is on their own domain or site (see the portal's layout). */
  customHtml: string;
};

const image = { select: { id: true, status: true, width: true, height: true } } as const;

/** The project's branding, with a lasting link to each image (its smallest stored size, at most 480px wide). */
export async function branding(where: { id: string } | { slug: string }): Promise<Branding | null> {
  const [project, installation] = await Promise.all([
    prisma.project.findUnique({
      where,
      select: {
        id: true,
        brandLogo: image,
        brandLogoDark: image,
        brandFavicon: image,
        seoImage: image,
        brandColor: true,
        headerLinks: true,
        footerLinks: true,
        poweredBy: true,
        licenseKey: true,
        badgeAddOn: true,
        articleActions: true,
        articleCopyMarkdown: true,
        articleOpenChatGpt: true,
        articleOpenClaude: true,
        articleUpdatedDate: true,
        docsTitle: true,
        docsSubtitle: true,
        docsPopular: true,
        colorScheme: true,
        themeSwitch: true,
        logoText: true,
        logoLink: true,
        sidebarLinks: true,
        seoTitle: true,
        seoDescription: true,
        headingFont: true,
        bodyFont: true,
        customCss: true,
        customHtml: true,
      },
    }),
    thisInstallation(),
  ]);
  if (!project) {
    return null;
  }
  // Lasting links: link cards are fetched long after the page, and API clients keep what they read.
  const url = lastingImage;
  const links = (value: unknown) => {
    const parsed = z.array(httpsLink).safeParse(value);
    return parsed.success ? parsed.data : [];
  };
  return {
    logo: url(project.brandLogo),
    logoDark: url(project.brandLogoDark),
    favicon: url(project.brandFavicon),
    color: project.brandColor,
    headerLinks: links(project.headerLinks),
    footerLinks: links(project.footerLinks),
    // Checked here, where the portal reads it, so turning poweredBy off in the database isn't enough.
    poweredBy: poweredByShown(project, installation),
    contentActions: {
      menu: project.articleActions,
      copyMarkdown: project.articleCopyMarkdown,
      chatGpt: project.articleOpenChatGpt,
      claude: project.articleOpenClaude,
      updatedDate: project.articleUpdatedDate,
    },
    docsHome: { title: project.docsTitle, subtitle: project.docsSubtitle, popular: project.docsPopular },
    colorScheme: (COLOR_SCHEMES as readonly string[]).includes(project.colorScheme) ? (project.colorScheme as ColorScheme) : "system",
    themeSwitch: project.themeSwitch,
    logoText: project.logoText,
    logoLink: project.logoLink,
    sidebarLinks: links(project.sidebarLinks),
    seo: { title: project.seoTitle, description: project.seoDescription },
    seoImage: shareImage(project.seoImage),
    fonts: { heading: isPortalFont(project.headingFont) ? project.headingFont : null, body: isPortalFont(project.bodyFont) ? project.bodyFont : null },
    customCss: project.customCss,
    customHtml: project.customHtml,
  };
}

export { brandCss } from "@/lib/colors";

const links = (where: string) =>
  z.array(httpsLink).max(MAX_BRAND_LINKS, `Add up to ${MAX_BRAND_LINKS} ${where} links`).optional();
const upload = z.string().trim().min(1).nullable().optional();
const UPLOAD = "the id of one of the images uploaded in the app, null to remove";

/** What each field is, for branding.update's input and the branding it returns. */
const LINES = {
  logo: "The portal's logo",
  logoDark: "Shown instead of the logo in dark mode; without it the logo shows in both",
  favicon: "The portal's favicon",
  color: "The accent colour, #rrggbb; null for the brand green",
  headerLinks: "Links in the portal's header",
  footerLinks: "Links in the portal's footer",
  poweredBy: 'Whether the footer says "Powered by tuti"',
  contentActions: "What readers can do with an article",
  menu: "The “Copy page” menu at all",
  copyMarkdown: "Copy as Markdown, in the menu",
  chatGpt: "Open in ChatGPT, in the menu",
  claude: "Open in Claude, in the menu",
  updatedDate: "The article's “Updated” date",
  docsHome: "The docs' home",
  docsTitle: "The title at its top; empty for the default",
  docsSubtitle: "The subtitle under it; empty for the default",
  popular: "Whether each tab's overview lists its most-read articles, once there are three (on for new projects)",
  colorScheme: "Light or dark mode for readers who haven't picked one; system is their device's",
  themeSwitch:
    "Whether readers get a light/dark switch in the portal's footer; off, every reader gets colorScheme, except under a path of your site, where a theme the site keeps stays",
  logoText: "Text beside the logo (empty: none; without a logo, the project's name shows)",
  logoLink: "Where the logo goes, an https address; null for the portal's home",
  sidebarLinks: "Links above the docs' tree",
  seo: "The portal's search listing, and how it shows where it's shared",
  seoTitle: "Its title; empty for the project's name",
  seoDescription: "Its description",
  seoImage: "The image a link to the portal shows",
  fonts: "Fonts for headings and for text, from the portal fonts; null for the page's own",
  customCss: "The team's CSS, on every portal page",
  customHtml:
    "The team's HTML, scripts too, at the end of each page, only where the portal is on your own domain or a path of your site: never on its Tuti address, in the widget or on the app's own domain",
};

const contentActions = z
  .object({
    menu: z.boolean().describe(LINES.menu).meta({ examples: [true] }),
    copyMarkdown: z.boolean().describe(LINES.copyMarkdown).meta({ examples: [true] }),
    chatGpt: z.boolean().describe(LINES.chatGpt).meta({ examples: [true] }),
    claude: z.boolean().describe(LINES.claude).meta({ examples: [true] }),
    updatedDate: z.boolean().describe(LINES.updatedDate).meta({ examples: [true] }),
  })
  .partial();
const docsHome = z
  .object({
    title: z
      .string()
      .trim()
      .max(DOCS_TITLE_MAX, `The title is up to ${DOCS_TITLE_MAX} characters`)
      .describe(`${LINES.docsTitle}; up to ${DOCS_TITLE_MAX} characters`)
      .meta({ examples: ["Acme Help Center"] }),
    subtitle: z
      .string()
      .trim()
      .max(DOCS_SUBTITLE_MAX, `The subtitle is up to ${DOCS_SUBTITLE_MAX} characters`)
      .describe(`${LINES.docsSubtitle}; up to ${DOCS_SUBTITLE_MAX} characters`)
      .meta({ examples: ["Guides and answers for every part of Acme"] }),
    popular: z.boolean().describe(LINES.popular).meta({ examples: [true] }),
  })
  .partial();
const httpsUrl = z.string().trim().max(500, "Keep links under 500 characters").pipe(z.url({ protocol: /^https$/, error: "Links need a full https:// address" }));
const fontId = z.enum(PORTAL_FONTS.map((font) => font.id) as [PortalFont, ...PortalFont[]]).nullable();
const fonts = z
  .object({
    heading: fontId.describe("For headings").meta({ examples: ["inter"] }),
    body: fontId.describe("For text").meta({ examples: [null] }),
  })
  .partial();
const seo = z
  .object({
    title: z
      .string()
      .trim()
      .max(SEO_TITLE_MAX, `The page title is up to ${SEO_TITLE_MAX} characters`)
      .describe(`${LINES.seoTitle}; up to ${SEO_TITLE_MAX} characters`)
      .meta({ examples: ["Acme Help Center"] }),
    description: z
      .string()
      .trim()
      .max(SEO_DESCRIPTION_MAX, `The description is up to ${SEO_DESCRIPTION_MAX} characters`)
      .describe(`${LINES.seoDescription}; up to ${SEO_DESCRIPTION_MAX} characters`)
      .meta({ examples: ["Guides and answers for every part of Acme"] }),
  })
  .partial();

const brandingOutput = z
  .object({
    logo: imageOutput.nullable().describe(LINES.logo),
    logoDark: imageOutput.nullable().describe(LINES.logoDark),
    favicon: imageOutput.nullable().describe(LINES.favicon),
    color: z.string().nullable().describe(LINES.color).meta({ examples: ["#5b21b6"] }),
    headerLinks: z.array(linkOutput).describe(LINES.headerLinks),
    footerLinks: z.array(linkOutput).describe(LINES.footerLinks),
    poweredBy: z.boolean().describe(`${LINES.poweredBy}: always, unless the project has a licence or the add-on`).meta({ examples: [true] }),
    contentActions: contentActions.required().describe(LINES.contentActions),
    docsHome: docsHome.required().describe(LINES.docsHome),
    colorScheme: z.enum(COLOR_SCHEMES).describe(LINES.colorScheme).meta({ examples: ["system"] }),
    themeSwitch: z.boolean().describe(LINES.themeSwitch).meta({ examples: [true] }),
    logoText: z.string().describe(LINES.logoText).meta({ examples: ["Help"] }),
    logoLink: z.string().nullable().describe(LINES.logoLink).meta({ examples: ["https://example.com"] }),
    sidebarLinks: z.array(linkOutput).describe(LINES.sidebarLinks),
    seo: seo.required().describe(LINES.seo),
    seoImage: imageOutput.nullable().describe(LINES.seoImage),
    fonts: fonts.required().describe(LINES.fonts),
    customCss: z.string().describe(LINES.customCss).meta({ examples: [""] }),
    customHtml: z.string().describe(LINES.customHtml).meta({ examples: [""] }),
  })
  .meta({ id: "Branding", description: "The portal's and its docs' look" });

export const getBranding = defineOperation({
  name: "branding.get",
  title: "Get the branding",
  summary: "Get the portal's branding: logos, favicon, colour, links, fonts, the docs' home, its search listing, custom code, and whether it says \"Powered by tuti\".",
  method: "GET",
  path: "/branding",
  scope: "read",
  access: "team",
  input: z.object({}),
  output: brandingOutput.describe("The portal's branding"),
  run: async ({ projectId }) => (await branding({ id: projectId }))!,
});

export const updateBranding = defineOperation({
  name: "branding.update",
  title: "Update the branding",
  summary: "Set the portal's and its docs' look. Fields left out stay as they are; a list sent replaces the list.",
  method: "PATCH",
  path: "/branding",
  scope: "write",
  access: "admin",
  errors: [409],
  input: z.object({
    logo: upload.describe(`${LINES.logo}: ${UPLOAD}`).meta({ examples: ["cm3media0001"] }),
    logoDark: upload.describe(`${LINES.logoDark}: ${UPLOAD}`).meta({ examples: [null] }),
    favicon: upload.describe(`${LINES.favicon}: ${UPLOAD}`).meta({ examples: ["cm3media0002"] }),
    color: hexColor.nullable().optional().describe(LINES.color).meta({ examples: ["#5b21b6"] }),
    headerLinks: links("header").describe(`${LINES.headerLinks}, up to ${MAX_BRAND_LINKS} https links (replaces the list)`),
    footerLinks: links("footer").describe(`${LINES.footerLinks}, up to ${MAX_BRAND_LINKS} https links (replaces the list)`),
    poweredBy: z
      .boolean()
      .optional()
      .describe(`${LINES.poweredBy}. false needs a licence for the project; where plans are sold, as on tuti.so, the "Powered by tuti" add-on on its paid plan instead`)
      .meta({ examples: [false] }),
    contentActions: contentActions.optional().describe(`${LINES.contentActions}: each true or false`),
    docsHome: docsHome.optional().describe(`${LINES.docsHome}: a title and subtitle at its top, empty for the defaults, and its popular articles`),
    colorScheme: z.enum(COLOR_SCHEMES).optional().describe(LINES.colorScheme).meta({ examples: ["system"] }),
    themeSwitch: z.boolean().optional().describe(LINES.themeSwitch).meta({ examples: [true] }),
    logoText: z
      .string()
      .trim()
      .max(LOGO_TEXT_MAX, `The logo text is up to ${LOGO_TEXT_MAX} characters`)
      .optional()
      .describe(`${LINES.logoText}; up to ${LOGO_TEXT_MAX} characters`)
      .meta({ examples: ["Help"] }),
    logoLink: httpsUrl.nullable().optional().describe(LINES.logoLink).meta({ examples: ["https://example.com"] }),
    sidebarLinks: links("sidebar").describe(`${LINES.sidebarLinks}, up to ${MAX_BRAND_LINKS} (replaces the list)`),
    seo: seo.optional().describe(LINES.seo),
    seoImage: upload.describe(`${LINES.seoImage}: ${UPLOAD}`).meta({ examples: [null] }),
    fonts: fonts.optional().describe(LINES.fonts),
    customCss: z
      .string()
      .max(CUSTOM_CODE_MAX, `Custom CSS is up to ${CUSTOM_CODE_MAX.toLocaleString("en")} characters`)
      .optional()
      .describe(`${LINES.customCss}; up to ${CUSTOM_CODE_MAX} characters`)
      .meta({ examples: [".tuti-header { border-bottom: 0; }"] }),
    customHtml: z
      .string()
      .max(CUSTOM_CODE_MAX, `Custom HTML is up to ${CUSTOM_CODE_MAX.toLocaleString("en")} characters`)
      .optional()
      .describe(`${LINES.customHtml}; up to ${CUSTOM_CODE_MAX} characters`)
      .meta({ examples: ['<script src="https://example.com/analytics.js" defer></script>'] }),
  }),
  output: brandingOutput.describe("The portal's branding, as changed"),
  example: {
    color: "#5b21b6",
    headerLinks: [{ label: "Docs", url: "https://docs.example.com" }],
    footerLinks: [{ label: "Privacy", url: "https://example.com/privacy" }],
    poweredBy: false,
  },
  run: async ({ projectId }, input) => {
    // Read before the transaction (it never changes), so the transaction needs no second connection.
    const installation = await thisInstallation();
    await saving(() =>
      prisma.$transaction(async (tx) => {
        // One save at a time per project, so two saves can't both release the old image, or each keep one the other replaced.
        await tx.$executeRaw`SELECT 1 FROM project WHERE id = ${projectId} FOR UPDATE`;
        const current = await tx.project.findUniqueOrThrow({
          where: { id: projectId },
          select: { brandLogoId: true, brandLogoDarkId: true, brandFaviconId: true, seoImageId: true, licenseKey: true, badgeAddOn: true },
        });
        if (input.poweredBy === false && !badgeLicensed({ id: projectId, ...current }, installation)) {
          throw new OperationError(
            400,
            "invalid_input",
            plansEnabled() ? 'Hiding "Powered by tuti" needs its add-on on this project\'s paid plan, in Billing' : 'Hiding "Powered by tuti" needs a licence for this project',
          );
        }
        const names = Object.keys(IMAGES) as ImageName[];
        const before = names.map((name) => current[IMAGES[name]]).filter((id) => id !== null);
        const after = names.map((name) => (input[name] !== undefined ? input[name] : current[IMAGES[name]])).filter((id) => id !== null);
        const added = [...new Set(after.filter((id) => !before.includes(id)))];
        // New images are this project's finished uploads. Content may share them (or one may be the logo
        // just replaced): release-media checks branding and content before it releases anything.
        if (added.length > 0) {
          // Images: a file attachment's upload is never one.
          const fresh = await tx.media.count({ where: { id: { in: added }, projectId, status: "READY", filename: null } });
          if (fresh !== added.length) {
            throw new OperationError(400, "invalid_input", MEDIA_GONE);
          }
        }
        // Before the project points at them: attaching locks the rows, so the cleanup can't take them meanwhile.
        await attachMedia(tx, projectId, added);
        await tx.project.update({
          where: { id: projectId },
          data: {
            ...Object.fromEntries(names.filter((name) => input[name] !== undefined).map((name) => [IMAGES[name], input[name]])),
            ...(input.color !== undefined && { brandColor: input.color === DEFAULT_WIDGET_COLOR ? null : input.color }),
            ...(input.headerLinks !== undefined && { headerLinks: input.headerLinks }),
            ...(input.footerLinks !== undefined && { footerLinks: input.footerLinks }),
            ...(input.poweredBy !== undefined && { poweredBy: input.poweredBy }),
            ...(input.contentActions?.menu !== undefined && { articleActions: input.contentActions.menu }),
            ...(input.contentActions?.copyMarkdown !== undefined && { articleCopyMarkdown: input.contentActions.copyMarkdown }),
            ...(input.contentActions?.chatGpt !== undefined && { articleOpenChatGpt: input.contentActions.chatGpt }),
            ...(input.contentActions?.claude !== undefined && { articleOpenClaude: input.contentActions.claude }),
            ...(input.contentActions?.updatedDate !== undefined && { articleUpdatedDate: input.contentActions.updatedDate }),
            ...(input.docsHome?.title !== undefined && { docsTitle: input.docsHome.title }),
            ...(input.docsHome?.subtitle !== undefined && { docsSubtitle: input.docsHome.subtitle }),
            ...(input.docsHome?.popular !== undefined && { docsPopular: input.docsHome.popular }),
            ...(input.colorScheme !== undefined && { colorScheme: input.colorScheme }),
            ...(input.themeSwitch !== undefined && { themeSwitch: input.themeSwitch }),
            ...(input.logoText !== undefined && { logoText: input.logoText }),
            ...(input.logoLink !== undefined && { logoLink: input.logoLink }),
            ...(input.sidebarLinks !== undefined && { sidebarLinks: input.sidebarLinks }),
            ...(input.seo?.title !== undefined && { seoTitle: input.seo.title }),
            ...(input.seo?.description !== undefined && { seoDescription: input.seo.description }),
            ...(input.fonts?.heading !== undefined && { headingFont: input.fonts.heading ?? "" }),
            ...(input.fonts?.body !== undefined && { bodyFont: input.fonts.body ?? "" }),
            ...(input.customCss !== undefined && { customCss: input.customCss }),
            ...(input.customHtml !== undefined && { customHtml: input.customHtml }),
          },
        });
        // Replaced images stay attached: the daily release-media job releases them once nothing in the
        // project uses them (it checks content too), and cleanup-media then frees their space.
      }),
    );
    return (await branding({ id: projectId }))!;
  },
});
