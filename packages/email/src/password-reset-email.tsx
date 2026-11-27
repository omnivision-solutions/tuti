import { Button } from "@react-email/components";

import { Paragraph } from "./blocks";
import { emailTranslator } from "./language";
import { buttonStyle, type EmailBrand, Layout, Note, Title } from "./layout";

/**
 * `project`: the portal it was asked on (sent on its behalf); none for the app (from Tuti). `language`: the page's it was
 * asked on (docs/plan.md, Languages), else English (the app's).
 */
type PasswordResetProps = { project?: EmailBrand | null; url: string; minutes: number; language?: string | null };

export function PasswordResetEmail({ project, url, minutes, language }: PasswordResetProps) {
  const t = emailTranslator(language, "emails");
  const siteName = project?.projectName ?? "Tuti";
  return (
    <Layout preview={t("resetPreview", { name: siteName })} project={project ?? undefined} footer={t("resetIgnore")} language={language ?? undefined}>
      <Title>{t("resetTitle")}</Title>
      <Paragraph>{t.rich("resetText", { name: siteName, b: (chunks) => <strong>{chunks}</strong> })}</Paragraph>
      <Button
        href={url}
        style={buttonStyle(project?.accent)}
      >
        {t("resetButton")}
      </Button>
      <Note>{t("linkExpires", { minutes })}</Note>
    </Layout>
  );
}

export const passwordResetEmail = (props: PasswordResetProps) => ({
  subject: emailTranslator(props.language, "emails")("resetTitle"),
  body: <PasswordResetEmail {...props} />,
});

/** `project`: the portal the reset was asked on (sent on its behalf); none for the app. `language`: as the reset's. */
export function PasswordChangedEmail({ project, language }: { project?: EmailBrand | null; language?: string | null }) {
  const t = emailTranslator(language, "emails");
  return (
    <Layout preview={t("changedPreview")} project={project ?? undefined} language={language ?? undefined}>
      <Title>{t("changedTitle")}</Title>
      <Paragraph>{t("changedText")}</Paragraph>
      <Note kind="warn">{t("changedWarning", { forgot: emailTranslator(language, "auth")("forgotPassword") })}</Note>
    </Layout>
  );
}

export const passwordChangedEmail = (project?: EmailBrand | null, language?: string | null) => ({
  subject: emailTranslator(language, "emails")("changedTitle"),
  body: <PasswordChangedEmail project={project} language={language} />,
});
