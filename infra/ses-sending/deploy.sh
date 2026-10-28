#!/usr/bin/env bash
# Deploys sending support email with Amazon SES (template.yaml). Run with AWS credentials for the
# account and these set:
#   SES_CONFIGURATION_SET  the configuration set support email names (it must exist)
#   APP_URL                the app's origin: SNS posts SES's events to /api/email/events, which
#                          confirms the subscription (the app needs the SES_* settings first)
# Prints SES_EVENTS_TOPIC_ARN and the API user, to create the app's key for:
#   aws iam create-access-key --user-name <user>  (SES_ACCESS_KEY_ID, SES_SECRET_ACCESS_KEY)
set -euo pipefail

: "${SES_CONFIGURATION_SET:?}" "${APP_URL:?}" "${AWS_REGION:?}"
STACK="${STACK:-tuti-ses-sending}"
here="$(cd "$(dirname "$0")" && pwd)"

aws cloudformation deploy \
  --stack-name "$STACK" \
  --template-file "$here/template.yaml" \
  --capabilities CAPABILITY_IAM \
  --no-fail-on-empty-changeset \
  --parameter-overrides "ConfigurationSet=$SES_CONFIGURATION_SET" "AppUrl=$APP_URL"

output() {
  aws cloudformation describe-stacks --stack-name "$STACK" --query "Stacks[0].Outputs[?OutputKey=='$1'].OutputValue" --output text
}
echo "SES_REGION=$AWS_REGION SES_CONFIGURATION_SET=$SES_CONFIGURATION_SET SES_EVENTS_TOPIC_ARN=$(output EventsTopic)"
echo "API user: $(output ApiUser)"
