# @repo/email

Resend + React Email templates, with a Nodemailer/SMTP path for local Mailpit.
Built package (tsup → dist) with `development` export condition.

## Transport selection (by env)

- `EMAIL_SMTP_HOST` set → Nodemailer/SMTP (Mailpit locally).
- else `RESEND_API_KEY` → Resend (prod).

## API

- `createEmailClient({ logger? })` → `EmailClient` with `send({to,subject,html})`
  and `sendOtp(to, code)`.
- `renderOtpEmail(code, expiresInMinutes?)` → HTML string.
- Templates live in `templates/*.tsx` (React Email). `tsconfig` sets
  `jsx: react-jsx`; components are rendered via `@react-email/render`.

Env read via `@repo/env` `parse()` — never `process.env`.
