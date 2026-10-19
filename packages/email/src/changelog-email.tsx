import { Button, Heading, Link, Text } from "@react-email/components";
import { type Doc, toPlainText } from "@tuti/content";

import { colors, Layout } from "./layout";
import { EmailRichText } from "./rich-text";

type ChangelogProps = {
  projectName: string;
  entryTitle: string;
  entryUrl: string;
  doc: Doc;
  /** Where uploaded images are served from (MEDIA_PUBLIC_URL); without it, images are left out. */
  mediaBaseUrl?: string | null;
  unsubscribeUrl: string;
};

/** A published changelog entry, in full. Not sent yet: emailing subscribers comes with Phase 8. */
export function ChangelogEmail({ projectName, entryTitle, entryUrl, doc, mediaBaseUrl, unsubscribeUrl }: ChangelogProps) {
  return (
    <Layout preview={toPlainText(doc).slice(0, 140) || entryTitle}>
      <Text style={{ fontSize: 13, color: colors.muted, margin: "16px 0 0" }}>New from {projectName}</Text>
      <Heading as="h1" style={{ fontSize: 22, lineHeight: "30px", color: colors.text, margin: "4px 0 16px" }}>
        {entryTitle}
      </Heading>
      <EmailRichText doc={doc} mediaBaseUrl={mediaBaseUrl} linkUrl={entryUrl} />
      <Button
        href={entryUrl}
        style={{ backgroundColor: colors.green, color: "#ffffff", borderRadius: 10, padding: "12px 20px", fontSize: 15, fontWeight: 600 }}
      >
        See the update
      </Button>
      <Text style={{ fontSize: 13, color: colors.muted, lineHeight: "20px", marginTop: 24 }}>
        You&apos;re getting this because you follow {projectName}.{" "}
        <Link href={unsubscribeUrl} style={{ color: colors.muted, textDecoration: "underline" }}>
          Unsubscribe from {projectName}
        </Link>
      </Text>
    </Layout>
  );
}

export const changelogEmail = (props: ChangelogProps) => ({
  subject: `${props.projectName}: ${props.entryTitle}`,
  body: <ChangelogEmail {...props} />,
});
