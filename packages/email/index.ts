import { render } from '@react-email/render';
import nodemailer from 'nodemailer';
import { Resend } from 'resend';
import { parse, z } from '@repo/env';
import { createLogger, type Logger } from '@repo/logging';
import { OtpEmail } from './templates/otp.js';

/**
 * Transactional email. Transport is chosen by environment:
 *   - `EMAIL_SMTP_HOST` set → Nodemailer/SMTP (Mailpit locally).
 *   - else `RESEND_API_KEY`  → Resend (prod).
 */

const envSchema = z.object({
  EMAIL_FROM: z.string().min(1),
  EMAIL_SMTP_HOST: z.string().optional(),
  EMAIL_SMTP_PORT: z.coerce.number().int().positive().optional(),
  RESEND_API_KEY: z.string().optional(),
});

export interface SendEmailInput {
  to: string;
  subject: string;
  html: string;
}

export interface EmailClient {
  send(input: SendEmailInput): Promise<void>;
  sendOtp(to: string, code: string): Promise<void>;
}

export interface CreateEmailClientOptions {
  logger?: Logger;
}

/** Render the OTP email template to an HTML string. */
export function renderOtpEmail(code: string, expiresInMinutes = 5): Promise<string> {
  return render(OtpEmail({ code, expiresInMinutes }));
}

export function createEmailClient(options: CreateEmailClientOptions = {}): EmailClient {
  const env = parse(envSchema);
  const logger = options.logger ?? createLogger({ service: 'email' });

  const useSmtp = Boolean(env.EMAIL_SMTP_HOST);

  const transporter = useSmtp
    ? nodemailer.createTransport({
        host: env.EMAIL_SMTP_HOST,
        port: env.EMAIL_SMTP_PORT ?? 1025,
        secure: false,
      })
    : null;

  const resend = !useSmtp && env.RESEND_API_KEY ? new Resend(env.RESEND_API_KEY) : null;

  async function send(input: SendEmailInput): Promise<void> {
    if (transporter) {
      await transporter.sendMail({
        from: env.EMAIL_FROM,
        to: input.to,
        subject: input.subject,
        html: input.html,
      });
      logger.debug('email.sent', { transport: 'smtp', to: input.to });
      return;
    }
    if (resend) {
      const { error } = await resend.emails.send({
        from: env.EMAIL_FROM,
        to: input.to,
        subject: input.subject,
        html: input.html,
      });
      if (error) throw new Error(`Resend error: ${error.message}`);
      logger.debug('email.sent', { transport: 'resend', to: input.to });
      return;
    }
    throw new Error('No email transport configured (set EMAIL_SMTP_HOST or RESEND_API_KEY)');
  }

  return {
    send,
    async sendOtp(to, code) {
      const html = await renderOtpEmail(code);
      await send({ to, subject: 'Your verification code', html });
    },
  };
}

export { OtpEmail };
