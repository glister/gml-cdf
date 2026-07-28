---
name: visual-verification
description: Screenshot and visually verify a UI change in the running dev app using agent-browser, including refreshing the expired `dev` auth session. Use whenever a web or mobile UI change needs to be confirmed to look correct before the task is considered done.
---

# Visual verification with agent-browser

When making UI changes, take a screenshot to verify your work looks correct before considering the task done. Use `agent-browser` (already installed globally).

## Basic screenshot workflow

Screenshots use a persistent authenticated session named `dev`. Always use `--session dev` so cookies persist between commands.

```bash
agent-browser --session dev open http://localhost:3000/some/route
agent-browser --session dev screenshot .screenshots/some-route.png --viewport 1280x800
```

For mobile checks, use `--viewport 375x812`. For full-page (scrolling) shots, add `--full-page`.

Save all screenshots to `.screenshots/` (gitignored). Use descriptive filenames like `dashboard-after-fix.png`, not `test.png`.

## After taking a screenshot

Read it back with the Read tool and check that the change you made is actually visible and correct. If it looks wrong, iterate. Do not mark a UI task complete without visually confirming.

## Handling expired auth

If a screenshot shows the login page (`/login`) instead of the expected authenticated content, the dev session has expired. Refresh it and retake the shot:

```bash
./scripts/refresh-auth.sh
```

The script authenticates via better-auth's HTTP API and injects the resulting
session cookie into the `dev` session — it does **not** drive the login form, so
it's immune to login-UI changes and to the Turnstile widget (a client-side gate
the API path doesn't hit). It reads the OTP from Mailpit and signs in as the
seeded admin (`admin@cdf.local`; override with `DEV_AUTH_EMAIL=...`). It takes a
few seconds. After it succeeds, retake the screenshot with the same
`agent-browser --session dev` command.

Do not attempt to fill in the login form manually. Do not attempt to bypass
authentication. Always use the refresh script.

## If refresh-auth.sh fails

- Check that the dev server is running (both the web app on `PORT_WEB` and the
  api app on `PORT_API` — auth lives on the api app).
- Check that Mailpit is running (`http://localhost:$PORT_MAILPIT_UI`, `17021` at
  the default prefix).
- If the OTP request is rejected: confirm the account is seeded, and that
  `TURNSTILE_SECRET_KEY` is **not** set in `.env.secrets` — if it is, the server
  enforces the captcha on OTP send (use the Cloudflare test key, or unset it for
  dev).

## When NOT to screenshot

- Backend-only changes (API routes, DB migrations, non-UI logic)
- Small refactors with no visual output
- Text-only changes (copy edits are fine to verify via code diff)

Screenshotting has a cost — do it when it adds real signal, not reflexively.
