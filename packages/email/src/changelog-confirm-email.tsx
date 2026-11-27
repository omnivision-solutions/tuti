import { Button } from "@react-email/components";

import { Paragraph } from "./blocks";
import { emailTranslator } from "./language";
import { buttonStyle, type EmailBrand, Eyebrow, Layout, Title } from "./layout";

/**
 * `optedOut`: the address has turned all of the project's emails off, which wins until they turn them back on.
 * `language`: the subscription's (the page it was asked on), else English.
 */
type ChangelogConfirmProps = EmailBrand & { url: string; optedOut?: boolean; language?: string | null };

/**
 * "Get updates by email" on a portal's changelog: nothing is sent until they confirm. To an address that's turned all
 * of the project's emails off, it promises nothing: it says so, and the link turns them back on.
 */
export function ChangelogConfirmEmail({ projectName, url, optedOut = false, accent, poweredBy, logo, logoText, language }: ChangelogConfirmProps) {
  const t = emailTranslator(language, "emails");
  const name = projectName;
  const b = (chunks: React.ReactNode) => <strong>{chunks}</strong>;
  return (
    <Layout
      preview={optedOut ? t("optedOutPreview", { name }) : t("confirmPreview", { name })}
      project={{ projectName, accent, poweredBy, logo, logoText }}
      footer={t("confirmIgnore")}
      language={language ?? undefined}
    >
      <Eyebrow accent={accent}>{t("oneMoreStep")}</Eyebrow>
      <Title>{optedOut ? t("turnOnTitle", { name }) : t("confirmTitle")}</Title>
      <Paragraph>{optedOut ? t.rich("optedOutText", { name, b }) : t.rich("confirmText", { name, b })}</Paragraph>
      <Button
        href={url}
        style={buttonStyle(accent)}
      >
        {optedOut ? t("turnOnTitle", { name }) : t("confirmButton")}
      </Button>
    </Layout>
  );
}

export const changelogConfirmEmail = (props: ChangelogConfirmProps) => {
  const t = emailTranslator(props.language, "emails");
  return {
    subject: props.optedOut ? t("turnOnSubject", { name: props.projectName }) : t("confirmSubject", { name: props.projectName }),
    body: <ChangelogConfirmEmail {...props} />,
  };
};
