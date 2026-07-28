#!/usr/bin/env bash
set -euo pipefail

# Refresh the `dev` agent-browser session's auth cookie so screenshots of
# authenticated routes work again.
#
# How it works — and why it doesn't touch the login form:
#   The login UI gates OTP send behind a Cloudflare Turnstile widget, which needs
#   the challenges.cloudflare.com script to load and mint a token — it can't in a
#   headless/sandboxed browser. But Turnstile is a *client-side* gate: the server
#   only verifies it when TURNSTILE_SECRET_KEY is set in .env.secrets (the captcha
#   plugin "ships inert" otherwise, per .env). So in dev we skip the browser form
#   entirely and drive better-auth's HTTP API directly:
#     1. POST send-verification-otp  (email OTP; Mailpit captures the mail)
#     2. read the 6-digit code from Mailpit
#     3. POST sign-in/email-otp with a cookie jar → get the signed session cookie
#     4. inject that cookie into the agent-browser `dev` session
#   No login-form selectors, so this doesn't break when the login UI changes.
#
# The auth API lives on the *api* app (VITE_API_URL / PORT_API), NOT the web app.
#
# Override the account with DEV_AUTH_EMAIL=... (default: the seeded admin).
# If TURNSTILE_SECRET_KEY *is* set in .env.secrets, the server enforces captcha on
# the send endpoint and step 1 will fail — unset it for dev, or use the test key.

# Ports are prefix-derived (package.json "portPrefix"); read the real host values
# from .env rather than hardcoding. grep+cut, not sourcing — .env holds connection
# strings with ';' that would break `.`-sourcing.
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
env_val() { grep -E "^$1=" "$ROOT/.env" | head -1 | cut -d= -f2-; }

# --- config ---
APP_URL="http://localhost:$(env_val PORT_WEB)"          # web app — where we screenshot
API_URL="http://localhost:$(env_val PORT_API)"          # api app — where auth lives
MAILPIT_URL="http://localhost:$(env_val PORT_MAILPIT_UI)"
DEV_EMAIL="${DEV_AUTH_EMAIL:-admin@cdf.local}"          # the seeded admin (override via env)
SESSION="dev"          # agent-browser named session; reused by screenshot commands
COOKIE_NAME="better-auth.session_token"
# --------------

JAR="$(mktemp)"
trap 'rm -f "$JAR"' EXIT

echo "Clearing old Mailpit messages..."
curl -s -X DELETE "$MAILPIT_URL/api/v1/messages" >/dev/null

echo "Requesting OTP for $DEV_EMAIL (via $API_URL)..."
SEND=$(curl -s -X POST "$API_URL/api/auth/email-otp/send-verification-otp" \
  -H 'Content-Type: application/json' \
  -d "{\"email\":\"$DEV_EMAIL\",\"type\":\"sign-in\"}")
if ! echo "$SEND" | jq -e '.success == true' >/dev/null 2>&1; then
  echo "OTP request was not accepted. Response: $SEND"
  echo "  • Is the account '$DEV_EMAIL' seeded? (only seeded users get an OTP)"
  echo "  • Is TURNSTILE_SECRET_KEY set in .env.secrets? If so the server enforces"
  echo "    the captcha here — unset it for dev, or use the Cloudflare test key."
  exit 1
fi

echo "Waiting for email..."
MSG_ID=""
for _ in $(seq 1 20); do
  sleep 0.5
  MSG_ID=$(curl -s "$MAILPIT_URL/api/v1/messages?limit=1" | jq -r '.messages[0].ID // empty')
  [ -n "$MSG_ID" ] && break
done
[ -z "$MSG_ID" ] && { echo "No OTP email received"; exit 1; }

OTP=$(curl -s "$MAILPIT_URL/api/v1/message/$MSG_ID" \
  | jq -r '.Text' | grep -oE '[0-9]{6}' | head -1)
[ -z "$OTP" ] && { echo "Could not extract OTP from email"; exit 1; }
echo "Got OTP: $OTP"

echo "Verifying OTP and capturing the session cookie..."
VERIFY=$(curl -s -c "$JAR" -X POST "$API_URL/api/auth/sign-in/email-otp" \
  -H 'Content-Type: application/json' \
  -d "{\"email\":\"$DEV_EMAIL\",\"otp\":\"$OTP\"}")
if ! echo "$VERIFY" | jq -e '.token' >/dev/null 2>&1; then
  echo "Sign-in failed. Response: $VERIFY"
  exit 1
fi

# The signed cookie value (token + signature) lives in the jar, not the JSON body.
# Netscape jar: tab-separated; name is the second-to-last field, value the last.
COOKIE_LINE=$(grep -i "$COOKIE_NAME" "$JAR" | tail -1 || true)
[ -z "$COOKIE_LINE" ] && { echo "Session cookie '$COOKIE_NAME' not found in jar"; exit 1; }
COOKIE_VALUE=$(printf '%s' "$COOKIE_LINE" | awk -F'\t' '{print $NF}')
[ -z "$COOKIE_VALUE" ] && { echo "Could not read session cookie value"; exit 1; }

echo "Injecting cookie into agent-browser session '$SESSION'..."
# Host-only cookie for `localhost` — cookies ignore port, so the browser sends it
# to both the web app (SSR session resolution) and the api app (client tRPC calls).
agent-browser --session "$SESSION" cookies set "$COOKIE_NAME" "$COOKIE_VALUE" \
  --url "$APP_URL" --path / --httpOnly >/dev/null

# Warm the session and confirm we're actually authenticated (not bounced to /login).
agent-browser --session "$SESSION" open "$APP_URL/dashboard" >/dev/null 2>&1 || true
sleep 1.5
LANDED=$(agent-browser --session "$SESSION" eval "location.pathname" 2>/dev/null || echo '"?"')
case "$LANDED" in
  *login*)
    echo "Still on the login page after injecting the cookie — auth did not take."
    echo "Landed at: $LANDED"
    exit 1
    ;;
  *)
    echo "Auth refreshed. Session '$SESSION' is ready for screenshots (landed at $LANDED)."
    ;;
esac
