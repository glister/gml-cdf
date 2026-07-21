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
  `jsx: react-jsx` (governs the tsup `dist` build); components are rendered via
  `@react-email/render`.
- **Every template must `import React from 'react';` as its first import.** In
  dev these templates are consumed as source (the `development` export
  condition), and the consuming app's tsx/esbuild applies the automatic JSX
  runtime only to files in its own tsconfig scope — out-of-scope templates fall
  back to the classic `React.createElement` transform, which throws "React is
  not defined" without a React binding in scope. Importing React is
  runtime-agnostic and works regardless of which JSX runtime a consumer picks.

Env read via `@repo/env` `parse()` — never `process.env`.
