import { imageKey, imageWidths } from "@tuti/content/media";
import { prisma } from "@tuti/db";
import { mediaStorage } from "@tuti/shared/storage";
import { z } from "zod";

import { attachMedia, MEDIA_GONE } from "../content";
import { installation as thisInstallation, licensedUntil, licenseNow } from "../license";
import { type ContentActions, DOCS_SUBTITLE_MAX, DOCS_TITLE_MAX, type DocsHome } from "@/lib/portal-look";

import { saving } from "./create";
import { defineOperation, OperationError } from "./define";
import { DEFAULT_WIDGET_COLOR, hexColor, httpsLink, type WidgetLink } from "./widget";

/**
 * The portal's and its docs' look (Phase 10, Customize): logos, favicon, accent colour, header and
 * footer links, "Powered by", what readers can do with an article, and the docs' home.
 */

export const MAX_BRAND_LINKS = 5;

/** Where each image's upload id is stored. */
const IMAGES = { logo: "brandLogoId", logoDark: "brandLogoDarkId", favicon: "brandFaviconId" } as const;
type ImageName = keyof typeof IMAGES;

export type BrandImage = { id: string; url: string; width: number; height: number };
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
};

const image = { select: { id: true, status: true, width: true, height: true } } as const;

/** The project's branding, with each image's URL on the media host (its smallest stored size, at most 480px wide). */
export async function branding(where: { id: string } | { slug: string }): Promise<Branding | null> {
  const [project, installation] = await Promise.all([
    prisma.project.findUnique({
      where,
      select: {
        id: true,
        brandLogo: image,
        brandLogoDark: image,
        brandFavicon: image,
        brandColor: true,
        headerLinks: true,
        footerLinks: true,
        poweredBy: true,
        licenseKey: true,
        articleActions: true,
        articleCopyMarkdown: true,
        articleOpenChatGpt: true,
        articleOpenClaude: true,
        articleUpdatedDate: true,
        docsTitle: true,
        docsSubtitle: true,
        docsPopular: true,
      },
    }),
    thisInstallation(),
  ]);
  if (!project) {
    return null;
  }
  const storage = mediaStorage();
  const url = (media: { id: string; status: string; width: number | null; height: number | null } | null): BrandImage | null =>
    storage && media?.status === "READY" && media.width && media.height
      ? { id: media.id, url: storage.publicUrl(imageKey(media.id, imageWidths(media.width)[0]!)), width: media.width, height: media.height }
      : null;
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
    poweredBy:
      project.poweredBy || !licensedUntil(project.licenseKey, { installation: installation.id, project: project.id }, licenseNow(installation)),
    contentActions: {
      menu: project.articleActions,
      copyMarkdown: project.articleCopyMarkdown,
      chatGpt: project.articleOpenChatGpt,
      claude: project.articleOpenClaude,
      updatedDate: project.articleUpdatedDate,
    },
    docsHome: { title: project.docsTitle, subtitle: project.docsSubtitle, popular: project.docsPopular },
  };
}

export { brandCss } from "@/lib/colors";

const links = (where: string) =>
  z.array(httpsLink).max(MAX_BRAND_LINKS, `Add up to ${MAX_BRAND_LINKS} ${where} links`).optional();
const upload = z.string().trim().min(1).nullable().optional();
const contentActions = z.object({ menu: z.boolean(), copyMarkdown: z.boolean(), chatGpt: z.boolean(), claude: z.boolean(), updatedDate: z.boolean() }).partial();
const docsHome = z
  .object({
    title: z.string().trim().max(DOCS_TITLE_MAX, `The title is up to ${DOCS_TITLE_MAX} characters`),
    subtitle: z.string().trim().max(DOCS_SUBTITLE_MAX, `The subtitle is up to ${DOCS_SUBTITLE_MAX} characters`),
    popular: z.boolean(),
  })
  .partial();

export const getBranding = defineOperation({
  name: "branding.get",
  summary: "Get the portal's branding: logos, favicon, colour, header and footer links, and whether it says \"Powered by tuti\"",
  method: "GET",
  path: "/branding",
  scope: "read",
  access: "team",
  input: z.object({}),
  run: async ({ projectId }) => (await branding({ id: projectId }))!,
});

export const updateBranding = defineOperation({
  name: "branding.update",
  summary: `Set the portal's branding: logo, logoDark and favicon (ids of images uploaded in the app, null to remove), colour (#rrggbb, null for the brand green), up to ${MAX_BRAND_LINKS} https links each for the header and footer (replaces the list), poweredBy (false needs a licence for the project), contentActions (what readers can do with an article: the "Copy page" menu at all, copyMarkdown, chatGpt and claude in it, and the "Updated" date; each true or false) and docsHome (the docs' home: a title up to ${DOCS_TITLE_MAX} characters and a subtitle up to ${DOCS_SUBTITLE_MAX} above its search box, empty for the defaults, and popular to list its most-read articles). Fields left out stay as they are`,
  method: "PATCH",
  path: "/branding",
  scope: "write",
  access: "admin",
  input: z.object({
    logo: upload,
    logoDark: upload,
    favicon: upload,
    color: hexColor.nullable().optional(),
    headerLinks: links("header"),
    footerLinks: links("footer"),
    poweredBy: z.boolean().optional(),
    contentActions: contentActions.optional(),
    docsHome: docsHome.optional(),
  }),
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
          select: { brandLogoId: true, brandLogoDarkId: true, brandFaviconId: true, licenseKey: true },
        });
        if (input.poweredBy === false && !licensedUntil(current.licenseKey, { installation: installation.id, project: projectId }, licenseNow(installation))) {
          throw new OperationError(400, "invalid_input", 'Hiding "Powered by tuti" needs a licence for this project');
        }
        const names = Object.keys(IMAGES) as ImageName[];
        const before = names.map((name) => current[IMAGES[name]]).filter((id) => id !== null);
        const after = names.map((name) => (input[name] !== undefined ? input[name] : current[IMAGES[name]])).filter((id) => id !== null);
        const added = [...new Set(after.filter((id) => !before.includes(id)))];
        // New images are this project's finished uploads. Content may share them (or one may be the logo
        // just replaced): release-media checks branding and content before it releases anything.
        if (added.length > 0) {
          const fresh = await tx.media.count({ where: { id: { in: added }, projectId, status: "READY" } });
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
          },
        });
        // Replaced images stay attached: the daily release-media job releases them once nothing in the
        // project uses them (it checks content too), and cleanup-media then frees their space.
      }),
    );
    return (await branding({ id: projectId }))!;
  },
});
