import { Button, Text } from "@react-email/components";

import { buttonStyle, colors, type EmailBrand, FooterLink, Layout } from "./layout";

/** `note`: the team's comment posted with the completion, quoted under the news. */
type ShippedProps = EmailBrand & { postTitle: string; postUrl: string; unsubscribeUrl: string; note?: { from: string; text: string } };

export function ShippedEmail({ projectName, postTitle, postUrl, unsubscribeUrl, note, accent, poweredBy }: ShippedProps) {
  return (
    <Layout
      preview={`${postTitle} is done.`}
      project={{ projectName, accent, poweredBy }}
      footer={
        <>
          You&apos;re getting this because you posted, voted, commented on or subscribed to it.{" "}
          <FooterLink href={unsubscribeUrl}>Unsubscribe from {projectName}</FooterLink>
        </>
      }
    >
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
        style={buttonStyle(accent)}
      >
        See the post
      </Button>
    </Layout>
  );
}

export const shippedEmail = (props: ShippedProps) => ({
  subject: `Done: ${props.postTitle}`,
  body: <ShippedEmail {...props} />,
});
