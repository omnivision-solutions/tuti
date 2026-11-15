import { Button, Heading, Img, Text } from "@react-email/components";
import { type Doc, toPlainText } from "@tuti/content";
import type { MediaUrls } from "@tuti/content/media";

import { buttonStyle, colors, type EmailBrand, FooterLink, Layout } from "./layout";
import { CONTENT_WIDTH, EmailRichText } from "./rich-text";

type ChangelogProps = EmailBrand & {
  entryTitle: string;
  entryUrl: string;
  doc: Doc;
  /** Its cover image (a lasting URL of its email JPEG), shown under the title; null without one. */
  coverUrl?: string | null;
  /** Lasting URLs of its images' files (lastingMediaUrls in apps/web); images without one are left out. */
  mediaUrls?: MediaUrls | null;
  unsubscribeUrl: string;
};

/** A published changelog entry, in full, to the changelog's subscribers. */
export function ChangelogEmail({ projectName, entryTitle, entryUrl, doc, coverUrl, mediaUrls, unsubscribeUrl, accent, poweredBy }: ChangelogProps) {
  return (
    <Layout
      preview={toPlainText(doc).slice(0, 140) || entryTitle}
      project={{ projectName, accent, poweredBy }}
      footer={
        <>
          You&apos;re getting this because you subscribed to {projectName}&apos;s changelog. <FooterLink href={unsubscribeUrl}>Unsubscribe</FooterLink>
        </>
      }
    >
      <Text style={{ fontSize: 13, color: colors.muted, margin: "16px 0 0" }}>New from {projectName}</Text>
      <Heading as="h1" style={{ fontSize: 22, lineHeight: "30px", color: colors.text, margin: "4px 0 16px" }}>
        {entryTitle}
      </Heading>
      {coverUrl && <Img src={coverUrl} alt={entryTitle} width={CONTENT_WIDTH} style={{ borderRadius: 10, margin: "0 0 16px", maxWidth: "100%", height: "auto" }} />}
      <EmailRichText doc={doc} mediaUrls={mediaUrls} linkUrl={entryUrl} accent={accent} />
      <Button
        href={entryUrl}
        style={buttonStyle(accent)}
      >
        See the update
      </Button>
    </Layout>
  );
}

export const changelogEmail = (props: ChangelogProps) => ({
  subject: `${props.projectName}: ${props.entryTitle}`,
  body: <ChangelogEmail {...props} />,
});
