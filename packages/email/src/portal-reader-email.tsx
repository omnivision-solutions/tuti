import { Button } from "@react-email/components";

import { Paragraph } from "./blocks";
import { emailTranslator } from "./language";
import { buttonStyle, type EmailBrand, Eyebrow, Layout, Note, Title } from "./layout";

/** `language`: the reader's (their saved one while the portal serves it, else its default). */
type PortalReaderProps = EmailBrand & { inviterName: string; email: string; url: string; language?: string };

/** To someone the team added as a reader of its private portal: where to sign in, and with which address. */
export function PortalReaderEmail({ inviterName, projectName, email, url, accent, poweredBy, logo, logoText, language }: PortalReaderProps) {
  const t = emailTranslator(language, "emails");
  return (
    <Layout preview={t("readerPreview", { name: projectName })} project={{ projectName, accent, poweredBy, logo, logoText }} footer={t("readerFooter")} language={language}>
      <Eyebrow accent={accent}>{t("readerEyebrow")}</Eyebrow>
      <Title>{t("readerTitle", { inviter: inviterName, name: projectName })}</Title>
      <Paragraph>{t("readerText", { name: projectName })}</Paragraph>
      <Button href={url} style={buttonStyle(accent)}>
        {t("readerButton")}
      </Button>
      <Note>{t.rich("readerNote", { email, // What the sign-in page calls it, in the same words.
        button: emailTranslator(language, "auth")("emailSignInLink"), b: (chunks) => <strong>{chunks}</strong> })}</Note>
    </Layout>
  );
}

export const portalReaderEmail = (props: PortalReaderProps) => ({
  subject: emailTranslator(props.language, "emails")("readerSubject", { inviter: props.inviterName, name: props.projectName }),
  body: <PortalReaderEmail {...props} />,
});
