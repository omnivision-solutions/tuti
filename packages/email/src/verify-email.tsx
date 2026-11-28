import { Text } from "@react-email/components";

import { emailTranslator } from "./language";
import { Buttons, Layout, textStyle, Title } from "./layout";

/** `language`: the portal page's it was asked on (docs/plan.md, Languages), else English (the app's). */
type VerifyProps = { name: string; url: string; language?: string };

export const verifyEmailSubject = (language?: string) => emailTranslator(language, "emails")("verifySubject");

export function VerifyEmail({ name, url, language }: VerifyProps) {
  const t = emailTranslator(language, "emails");
  return (
    <Layout preview={t("verifyPreview")} footer={t("verifyFooter")} language={language}>
      {/* Sent on signing up on the app or a portal, and again on Resend, maybe months later: no welcome. */}
      <Title>{t("verifyTitle", { name })}</Title>
      <Text style={textStyle}>{t("verifyText")}</Text>
      <Buttons href={url} label={t("verifyButton")} />
    </Layout>
  );
}

export const verifyEmail = (props: VerifyProps) => ({
  subject: verifyEmailSubject(props.language),
  body: <VerifyEmail {...props} />,
});
