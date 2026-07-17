#!/usr/bin/env bash
set -euo pipefail

# Ports are prefix-derived (package.json "portPrefix"); read the real host values
# from .env rather than hardcoding. grep+cut, not sourcing — .env holds connection
# strings with ';' that would break `.`-sourcing.
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
env_val() { grep -E "^$1=" "$ROOT/.env" | head -1 | cut -d= -f2-; }

# --- config ---
APP_URL="http://localhost:$(env_val PORT_WEB)"
MAILPIT_URL="http://localhost:$(env_val PORT_MAILPIT_UI)"
DEV_EMAIL="dev@example.com"
SESSION="dev"   # agent-browser named session; reused by screenshot commands
# --------------

echo "Clearing old Mailpit messages..."
curl -s -X DELETE "$MAILPIT_URL/api/v1/messages" >/dev/null

echo "Requesting OTP for $DEV_EMAIL..."
curl -s -X POST "$APP_URL/api/auth/email-otp/send-verification-otp" \
  -H 'Content-Type: application/json' \
  -d "{\"email\":\"$DEV_EMAIL\",\"type\":\"sign-in\"}" >/dev/null

echo "Waiting for email..."
for i in {1..10}; do
  sleep 0.5
  MSG_ID=$(curl -s "$MAILPIT_URL/api/v1/messages?limit=1" | jq -r '.messages[0].ID // empty')
  [ -n "$MSG_ID" ] && break
done
[ -z "$MSG_ID" ] && { echo "No OTP email received"; exit 1; }

OTP=$(curl -s "$MAILPIT_URL/api/v1/message/$MSG_ID" \
  | jq -r '.Text' | grep -oE '[0-9]{6}' | head -1)
[ -z "$OTP" ] && { echo "Could not extract OTP from email"; exit 1; }
echo "Got OTP: $OTP"

echo "Signing in via agent-browser session '$SESSION'..."
agent-browser --session "$SESSION" open "$APP_URL/login"
# Adjust these selectors to match your login form:
agent-browser --session "$SESSION" fill 'input[name="email"]' "$DEV_EMAIL"
agent-browser --session "$SESSION" click 'button[type="submit"]'
agent-browser --session "$SESSION" wait --selector 'input[name="otp"]'
agent-browser --session "$SESSION" fill 'input[name="otp"]' "$OTP"
agent-browser --session "$SESSION" click 'button[type="submit"]'
agent-browser --session "$SESSION" wait --load networkidle

echo "Auth refreshed. Session '$SESSION' is ready for screenshots."