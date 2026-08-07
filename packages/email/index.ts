import { render } from '@react-email/render';
import nodemailer from 'nodemailer';
import { Resend } from 'resend';
import { parse, z } from '@repo/env';
import { createLogger, type Logger } from '@repo/logging';
import { InvitationEmail } from './templates/invitation.js';
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
  // The web base URL, for the invitation sign-in link (PL-036).
  APP_URL: z.string().optional(),
});

export interface SendEmailInput {
  to: string;
  subject: string;
  html: string;
  /** Plain-text alternative. Sent alongside the HTML part where supplied. */
  text?: string;
}

/**
 * What the transport made of a send.
 *
 * `providerRef` is the provider's own message id, and it exists because core
 * plan 10 stores it on `notification_delivery.provider_ref`: when someone says
 * "I never got the email", the answer has to be a reference the provider's
 * dashboard recognises rather than a log line saying we tried. Optional, because
 * the SMTP path has no such id to give.
 */
export interface SendEmailResult {
  providerRef?: string;
}

export interface EmailClient {
  send(input: SendEmailInput): Promise<SendEmailResult>;
  sendOtp(to: string, code: string): Promise<void>;
  /** Send an account invitation (PL-036). The invitee signs in with an email OTP. */
  sendInvitation(to: string): Promise<void>;
}

export interface CreateEmailClientOptions {
  logger?: Logger;
}

/** Render the OTP email template to an HTML string. */
export function renderOtpEmail(code: string, expiresInMinutes = 5): Promise<string> {
  return render(OtpEmail({ code, expiresInMinutes }));
}

/** Render the invitation email template to an HTML string. */
export function renderInvitationEmail(signInUrl: string): Promise<string> {
  return render(InvitationEmail({ signInUrl }));
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

  async function send(input: SendEmailInput): Promise<SendEmailResult> {
    if (transporter) {
      const info = await transporter.sendMail({
        from: env.EMAIL_FROM,
        to: input.to,
        subject: input.subject,
        html: input.html,
        ...(input.text ? { text: input.text } : {}),
      });
      logger.debug('email.sent', { transport: 'smtp', to: input.to });
      return { providerRef: info.messageId };
    }
    if (resend) {
      const { data, error } = await resend.emails.send({
        from: env.EMAIL_FROM,
        to: input.to,
        subject: input.subject,
        html: input.html,
        ...(input.text ? { text: input.text } : {}),
      });
      if (error) throw new Error(`Resend error: ${error.message}`);
      logger.debug('email.sent', { transport: 'resend', to: input.to });
      return { providerRef: data?.id };
    }
    throw new Error('No email transport configured (set EMAIL_SMTP_HOST or RESEND_API_KEY)');
  }

  return {
    send,
    async sendOtp(to, code) {
      const html = await renderOtpEmail(code);
      await send({ to, subject: 'Your verification code', html });
    },
    async sendInvitation(to) {
      const signInUrl = `${env.APP_URL ?? ''}/login`;
      const html = await renderInvitationEmail(signInUrl);
      await send({ to, subject: 'You’ve been invited to CD Fencing', html });
    },
  };
}

export { OtpEmail };

/**
 * Notification email rendering (core plan 10 §5.4) — one shared frame around
 * content the notification kind already rendered and validated. See that
 * module's header for why nothing is re-interpolated here.
 */
export {
  renderNotificationEmail,
  NotificationEmail,
  type NotificationEmailInput,
  type NotificationEmailProps,
  type RenderedNotificationEmail,
} from './templates/notifications/index.js';
