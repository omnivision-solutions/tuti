import { Button, Img } from "@react-email/components";
import { type Doc, toPlainText } from "@tuti/content";
import type { MediaUrls } from "@tuti/content/media";
import { formatDate } from "@tuti/shared/dates";

import { buttonStyle, type EmailBrand, Eyebrow, FooterLink, Layout, Title } from "./layout";
import { CONTENT_WIDTH, EmailRichText } from "./rich-text";

type ChangelogProps = EmailBrand & {
  entryTitle: string;
  /** Its page on the portal; null for an email-only entry, which has none for readers (no "Read the update"). */
  entryUrl: string | null;
  doc: Doc;
  /** When it was published: "New · 15 November 2026" over its title, as the portal's changelog shows it. */
  publishedAt: Date;
  /** Its cover image (a lasting URL of its email JPEG), shown over the title; null without one. */
  coverUrl?: string | null;
  /** Lasting URLs of its images' files (lastingMediaUrls in apps/web); images without one are left out. */
  mediaUrls?: MediaUrls | null;
  unsubscribeUrl: string;
  /** The language of its title and text where it's a translation (docs/plan.md L16): their `lang`, for screen readers. */
  lang?: string;
};

/** A published changelog entry, in full, to the changelog's subscribers. */
export function ChangelogEmail({ projectName, entryTitle, entryUrl, publishedAt, doc, coverUrl, mediaUrls, unsubscribeUrl, accent, poweredBy, logo, logoText, lang }: ChangelogProps) {
  return (
    <Layout
      preview={toPlainText(doc).slice(0, 140) || entryTitle}
      project={{ projectName, accent, poweredBy, logo, logoText }}
      footer={
        <>
          You&apos;re getting this because you subscribed to {projectName}&apos;s changelog. <FooterLink href={unsubscribeUrl}>Unsubscribe</FooterLink>
        </>
      }
    >
      {coverUrl && <Img src={coverUrl} alt={entryTitle} width={CONTENT_WIDTH} style={{ borderRadius: 12, margin: "20px 0 0", maxWidth: "100%", height: "auto" }} />}
      <Eyebrow accent={accent}>{`New · ${formatDate(publishedAt)}`}</Eyebrow>
      {/* The team's words in their own language (the email's own words are the portal's, L5). */}
      <div lang={lang}>
        <Title>{entryTitle}</Title>
        <EmailRichText doc={doc} mediaUrls={mediaUrls} linkUrl={entryUrl} accent={accent} />
      </div>
      {entryUrl && (
        <Button href={entryUrl} style={buttonStyle(accent)}>
          Read the update
        </Button>
      )}
    </Layout>
  );
}

export const changelogEmail = (props: ChangelogProps) => ({
  subject: `${props.projectName}: ${props.entryTitle}`,
  body: <ChangelogEmail {...props} />,
});
