#!/bin/bash
set -e

# If we already have a session token, assume we are good to go
if [ -n "$AWS_SESSION_TOKEN" ]; then
    exec "$@"
fi

# Get the first MFA device ARN
MFA_SERIAL=$(aws iam list-mfa-devices --query 'MFADevices[0].SerialNumber' --output text)

if [ "$MFA_SERIAL" == "None" ]; then
    echo "❌ No MFA device found for user."
    exit 1
fi

echo "🔐 MFA Required. Device: $MFA_SERIAL" >&2
# read -p usually prints to stderr, but let's be safe and print prompt manually if needed, or trust it.
# Ideally use: read -p "Prompt" var
# The prompt of read -p is printed to stderr.
read -p "Enter MFA Token Code: " TOKEN_CODE

# Fetch credentials
if ! CREDS_JSON=$(aws sts get-session-token --serial-number "$MFA_SERIAL" --token-code "$TOKEN_CODE" 2>&1); then
    echo "❌ Failed to get session token:" >&2
    echo "$CREDS_JSON" >&2
    exit 1
fi

export AWS_ACCESS_KEY_ID=$(echo "$CREDS_JSON" | jq -r '.Credentials.AccessKeyId')
export AWS_SECRET_ACCESS_KEY=$(echo "$CREDS_JSON" | jq -r '.Credentials.SecretAccessKey')
export AWS_SESSION_TOKEN=$(echo "$CREDS_JSON" | jq -r '.Credentials.SessionToken')

if [ -z "$AWS_ACCESS_KEY_ID" ] || [ "$AWS_ACCESS_KEY_ID" == "null" ]; then
    echo "❌ Failed to parse credentials from response." >&2
    exit 1
fi

# Unset profile to prevent conflicts
unset AWS_PROFILE

# Verify identity
echo "✅ Credentials obtained. Testing identity..." >&2
aws sts get-caller-identity >&2

# Execute the command passed as arguments
exec "$@"
