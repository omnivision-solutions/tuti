import { Button } from "@react-email/components";

import { Paragraph } from "./blocks";
import { emailTranslator } from "./language";
import { buttonStyle, type EmailBrand, Layout, Note, Title } from "./layout";

/** `language`: the page's it was asked on (docs/plan.md, Languages), else English. */
type SignInLinkProps = EmailBrand & { url: string; minutes: number; language?: string };

export function SignInLinkEmail({ projectName, url, minutes, accent, poweredBy, logo, logoText, language }: SignInLinkProps) {
  const t = emailTranslator(language, "emails");
  return (
    <Layout
      preview={t("signInPreview", { name: projectName })}
      project={{ projectName, accent, poweredBy, logo, logoText }}
      footer={t("ignoreIt")}
      language={language}
    >
      <Title>{t("signInTo", { name: projectName })}</Title>
      <Paragraph>{t("signInText", { name: projectName })}</Paragraph>
      <Button
        href={url}
        style={buttonStyle(accent)}
      >
        {t("signInTo", { name: projectName })}
      </Button>
      <Note>{t("linkExpires", { minutes })}</Note>
    </Layout>
  );
}

export const signInLinkEmail = (props: SignInLinkProps) => ({
  subject: emailTranslator(props.language, "emails")("signInTo", { name: props.projectName }),
  body: <SignInLinkEmail {...props} />,
});
