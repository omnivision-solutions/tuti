import { Button, Link, Text } from "@react-email/components";

import { colors, Layout } from "./layout";

type ShippedProps = { projectName: string; postTitle: string; postUrl: string; unsubscribeUrl: string };

export function ShippedEmail({ projectName, postTitle, postUrl, unsubscribeUrl }: ShippedProps) {
  return (
    <Layout preview={`${postTitle} is done.`}>
      <Text style={{ fontSize: 15, color: colors.text, lineHeight: "24px" }}>
        Good news from {projectName}: <strong>{postTitle}</strong> is done. Thanks for asking for it.
      </Text>
      <Button
        href={postUrl}
        style={{ backgroundColor: colors.green, color: "#ffffff", borderRadius: 10, padding: "12px 20px", fontSize: 15, fontWeight: 600 }}
      >
        See the post
      </Button>
      <Text style={{ fontSize: 13, color: colors.muted, lineHeight: "20px", marginTop: 24 }}>
        You&apos;re getting this because you posted, voted or commented on it.{" "}
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
