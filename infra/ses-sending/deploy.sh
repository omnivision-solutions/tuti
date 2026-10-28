#!/usr/bin/env bash
# Deploys sending support email with Amazon SES (template.yaml). Run with AWS credentials for the
# account and these set:
#   SES_CONFIGURATION_SET  the configuration set support email names (it must exist)
# in a region whose SES has only Tuti's identities (see template.yaml), with the domains Tuti sends
# from verified there. Twice: first without APP_URL, which prints SES_EVENTS_TOPIC_ARN and the two
# users to create keys for (aws iam create-access-key --user-name <user>): the API user's is
# SES_ACCESS_KEY_ID and SES_SECRET_ACCESS_KEY; the SMTP user's id is SMTP_USERNAME, and SMTP_PASSWORD
# is derived from its secret for the region (AWS's "Obtaining Amazon SES SMTP credentials"), with
# SMTP_HOST email-smtp.<region>.amazonaws.com. Once the app runs with those settings, again with
#   APP_URL                the app's origin: SNS posts SES's events to /api/email/events, which
#                          confirms the subscription
set -euo pipefail

: "${SES_CONFIGURATION_SET:?}" "${AWS_REGION:?}"
STACK="${STACK:-tuti-ses-sending}"
here="$(cd "$(dirname "$0")" && pwd)"

aws cloudformation deploy \
  --stack-name "$STACK" \
  --template-file "$here/template.yaml" \
  --capabilities CAPABILITY_IAM \
  --no-fail-on-empty-changeset \
  --parameter-overrides "ConfigurationSet=$SES_CONFIGURATION_SET" "AppUrl=${APP_URL:-}"

output() {
  aws cloudformation describe-stacks --stack-name "$STACK" --query "Stacks[0].Outputs[?OutputKey=='$1'].OutputValue" --output text
}
echo "SES_REGION=$AWS_REGION SES_CONFIGURATION_SET=$SES_CONFIGURATION_SET SES_EVENTS_TOPIC_ARN=$(output EventsTopic)"
echo "API user: $(output ApiUser), SMTP user: $(output SmtpUser)"
