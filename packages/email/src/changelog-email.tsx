import { Button, Heading, Img, Link, Text } from "@react-email/components";
import { type Doc, toPlainText } from "@tuti/content";
import type { MediaUrls } from "@tuti/content/media";

import { colors, Layout } from "./layout";
import { CONTENT_WIDTH, EmailRichText } from "./rich-text";

type ChangelogProps = {
  projectName: string;
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
export function ChangelogEmail({ projectName, entryTitle, entryUrl, doc, coverUrl, mediaUrls, unsubscribeUrl }: ChangelogProps) {
  return (
    <Layout preview={toPlainText(doc).slice(0, 140) || entryTitle}>
      <Text style={{ fontSize: 13, color: colors.muted, margin: "16px 0 0" }}>New from {projectName}</Text>
      <Heading as="h1" style={{ fontSize: 22, lineHeight: "30px", color: colors.text, margin: "4px 0 16px" }}>
        {entryTitle}
      </Heading>
      {coverUrl && <Img src={coverUrl} alt={entryTitle} width={CONTENT_WIDTH} style={{ borderRadius: 10, margin: "0 0 16px", maxWidth: "100%", height: "auto" }} />}
      <EmailRichText doc={doc} mediaUrls={mediaUrls} linkUrl={entryUrl} />
      <Button
        href={entryUrl}
        style={{ backgroundColor: colors.green, color: colors.onGreen, borderRadius: 10, padding: "12px 20px", fontSize: 15, fontWeight: 600 }}
      >
        See the update
      </Button>
      <Text style={{ fontSize: 13, color: colors.muted, lineHeight: "20px", marginTop: 24 }}>
        You&apos;re getting this because you subscribed to {projectName}&apos;s changelog.{" "}
        <Link href={unsubscribeUrl} style={{ color: colors.muted, textDecoration: "underline" }}>
          Unsubscribe
        </Link>
      </Text>
    </Layout>
  );
}

export const changelogEmail = (props: ChangelogProps) => ({
  subject: `${props.projectName}: ${props.entryTitle}`,
  body: <ChangelogEmail {...props} />,
});
