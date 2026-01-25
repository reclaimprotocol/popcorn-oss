#!/bin/bash

# Unset existing session credentials so we can request new ones
# This fixes "Cannot call GetSessionToken with session credentials"
unset AWS_ACCESS_KEY_ID
unset AWS_SECRET_ACCESS_KEY
unset AWS_SESSION_TOKEN

# 1. Get MFA Device
MFA_SERIAL=$(aws iam list-mfa-devices --query 'MFADevices[0].SerialNumber' --output text 2>/dev/null)

if [ -z "$MFA_SERIAL" ] || [ "$MFA_SERIAL" = "None" ]; then
    echo "❌ No MFA device found for user (or AWS_PROFILE invalid)." >&2
    return 1 2>/dev/null || exit 1
fi

echo "🔐 MFA Required. Device: $MFA_SERIAL" >&2

# 2. Read Token
if [ -t 0 ]; then
    echo -n "Enter MFA Token Code: " >&2
    read TOKEN_CODE
else
    read TOKEN_CODE < /dev/tty
fi

# 3. Get Session Token
CREDS_JSON=$(aws sts get-session-token --serial-number "$MFA_SERIAL" --token-code "$TOKEN_CODE" 2>&1)

if [ $? -ne 0 ]; then
    echo "❌ Failed to get session token:" >&2
    echo "$CREDS_JSON" >&2
    return 1 2>/dev/null || exit 1
fi

# 4. Export Variables
export AWS_ACCESS_KEY_ID=$(echo "$CREDS_JSON" | jq -r '.Credentials.AccessKeyId')
export AWS_SECRET_ACCESS_KEY=$(echo "$CREDS_JSON" | jq -r '.Credentials.SecretAccessKey')
export AWS_SESSION_TOKEN=$(echo "$CREDS_JSON" | jq -r '.Credentials.SessionToken')

# Unset profile so tools use the exported env vars
unset AWS_PROFILE

echo "✅ AWS Credentials exported successfully!" >&2
echo "   Access Key: $AWS_ACCESS_KEY_ID" >&2
echo "   Session Token: ${AWS_SESSION_TOKEN:0:10}..." >&2
