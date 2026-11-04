import { Button, Link, Text } from "@react-email/components";

import { colors, Layout } from "./layout";

/** `note`: the team's comment posted with the completion, quoted under the news. */
type ShippedProps = { projectName: string; postTitle: string; postUrl: string; unsubscribeUrl: string; note?: { from: string; text: string } };

export function ShippedEmail({ projectName, postTitle, postUrl, unsubscribeUrl, note }: ShippedProps) {
  return (
    <Layout preview={`${postTitle} is done.`}>
      <Text style={{ fontSize: 15, color: colors.text, lineHeight: "24px" }}>
        Good news from {projectName}: <strong>{postTitle}</strong> is done. Thanks for asking for it.
      </Text>
      {note && (
        <Text style={{ fontSize: 15, color: colors.text, lineHeight: "24px", whiteSpace: "pre-line", borderLeft: `3px solid ${colors.border}`, paddingLeft: 12 }}>
          <span style={{ color: colors.muted }}>{note.from} from the team:</span>
          <br />
          {note.text}
        </Text>
      )}
      <Button
        href={postUrl}
        style={{ backgroundColor: colors.green, color: colors.onGreen, borderRadius: 10, padding: "12px 20px", fontSize: 15, fontWeight: 600 }}
      >
        See the post
      </Button>
      <Text style={{ fontSize: 13, color: colors.muted, lineHeight: "20px", marginTop: 24 }}>
        You&apos;re getting this because you posted, voted, commented on or subscribed to it.{" "}
        <Link href={unsubscribeUrl} style={{ color: colors.muted, textDecoration: "underline" }}>
          Unsubscribe from {projectName}
        </Link>
      </Text>
    </Layout>
  );
}

export const shippedEmail = (props: ShippedProps) => ({
  subject: `Done: ${props.postTitle}`,
  body: <ShippedEmail {...props} />,
});
