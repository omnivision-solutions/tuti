#!/usr/bin/env bash
# Deploys receiving for the support domain with Amazon SES (template.yaml) and the Lambda that posts
# each message to the app (index.mjs). Run with AWS credentials for the account and these set:
#   SUPPORT_EMAIL_DOMAIN  the support domain (e.g. tuti.email), verified in SES in AWS_REGION
#   APP_URL               the app's origin
#   INBOUND_SECRET        the app's INBOUND_SECRET
# Then point a wildcard MX record for the domain's subdomains at the printed target.
set -euo pipefail

: "${SUPPORT_EMAIL_DOMAIN:?}" "${APP_URL:?}" "${INBOUND_SECRET:?}" "${AWS_REGION:?}"
STACK="${STACK:-tuti-ses-inbound}"
here="$(cd "$(dirname "$0")" && pwd)"

aws cloudformation deploy \
  --stack-name "$STACK" \
  --template-file "$here/template.yaml" \
  --capabilities CAPABILITY_IAM \
  --no-fail-on-empty-changeset \
  --parameter-overrides "Domain=$SUPPORT_EMAIL_DOMAIN" "AppUrl=$APP_URL" "InboundSecret=$INBOUND_SECRET"

output() {
  aws cloudformation describe-stacks --stack-name "$STACK" --query "Stacks[0].Outputs[?OutputKey=='$1'].OutputValue" --output text
}

zip="$(mktemp -d)/function.zip"
(cd "$here" && zip -q "$zip" index.mjs)
aws lambda update-function-code --function-name "$(output Function)" --zip-file "fileb://$zip" --query LastModified --output text
aws lambda wait function-updated --function-name "$(output Function)"

# One rule set is active per region; this one receives only the support domain's subdomains.
aws ses set-active-receipt-rule-set --rule-set-name "$(output RuleSet)"

echo "Receiving for *.$SUPPORT_EMAIL_DOMAIN. DNS: *.$SUPPORT_EMAIL_DOMAIN MX 10 $(output MxTarget)"
