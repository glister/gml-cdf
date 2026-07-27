import * as React from 'react';
import { createFileRoute, useRouter } from '@tanstack/react-router';
import { useForm } from '@tanstack/react-form';
import { z } from 'zod';
import { authClient } from '../auth-client.js';
import { clientEnv } from '../env.client.js';
import { AuthShell } from '../components/auth/AuthShell.js';
import { OTPEntry } from '../components/auth/OTPEntry.js';
import { Turnstile, type TurnstileHandle } from '../components/auth/Turnstile.js';
import { CdButton } from '../components/ui/cd-button.js';

export const Route = createFileRoute('/login')({
  component: LoginPage,
});

const emailSchema = z.object({ email: z.email('Enter a valid email address') });

/* Microsoft four-square identity mark for the SSO button. */
const MicrosoftGlyph = (
  <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true">
    <rect x="1" y="1" width="10" height="10" fill="#F25022" />
    <rect x="13" y="1" width="10" height="10" fill="#7FBA00" />
    <rect x="1" y="13" width="10" height="10" fill="#00A4EF" />
    <rect x="13" y="13" width="10" height="10" fill="#FFB900" />
  </svg>
);

function LoginPage() {
  const router = useRouter();
  const [step, setStep] = React.useState<'signin' | 'otp'>('signin');
  const [email, setEmail] = React.useState('');
  const [error, setError] = React.useState<string | null>(null);
  const [otpError, setOtpError] = React.useState<null | 'wrong' | 'expired'>(null);
  const [msBusy, setMsBusy] = React.useState(false);

  const siteKey = clientEnv.VITE_TURNSTILE_SITE_KEY;
  const captchaEnabled = Boolean(siteKey);
  const [captchaToken, setCaptchaToken] = React.useState<string | null>(null);
  const turnstileRef = React.useRef<TurnstileHandle>(null);

  const sendForm = useForm({
    defaultValues: { email: '' },
    validators: { onChange: emailSchema },
    onSubmit: async ({ value }) => {
      setError(null);
      if (captchaEnabled && !captchaToken) {
        setError('Please complete the “I’m human” check first.');
        return;
      }
      const { error: err } = await authClient.emailOtp.sendVerificationOtp(
        { email: value.email, type: 'sign-in' },
        captchaToken ? { headers: { 'x-captcha-response': captchaToken } } : undefined,
      );
      if (err) {
        // Reset the single-use captcha token so a retry gets a fresh challenge.
        turnstileRef.current?.reset();
        setCaptchaToken(null);
        setError(err.message ?? 'We couldn’t send a code to that address.');
        return;
      }
      setEmail(value.email.trim());
      setStep('otp');
    },
  });

  const signInWithMicrosoft = async () => {
    setError(null);
    setMsBusy(true);
    const { error: err } = await authClient.signIn.social({
      provider: 'microsoft',
      callbackURL: '/dashboard',
    });
    // On success the browser is redirected to Microsoft; we only land here on error.
    if (err) {
      setError(err.message ?? 'Microsoft sign-in is not available right now.');
      setMsBusy(false);
    }
  };

  const verifyOtp = async (code: string) => {
    setOtpError(null);
    const { error: err } = await authClient.signIn.emailOtp({ email, otp: code });
    if (err) {
      setOtpError('wrong');
      return;
    }
    await router.navigate({ to: '/dashboard' });
  };

  const resendOtp = async () => {
    setOtpError(null);
    await authClient.emailOtp.sendVerificationOtp({ email, type: 'sign-in' });
  };

  return (
    <AuthShell backgroundImage="/login-background.jpg">
      {step === 'signin' ? (
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: 22,
            fontFamily: 'var(--font-sans)',
          }}
        >
          <div>
            <h1
              style={{
                margin: 0,
                font: '800 var(--text-xl)/1.15 var(--font-sans)',
                letterSpacing: 'var(--tracking-tight)',
                color: 'var(--text-strong)',
              }}
            >
              Welcome to Connect
            </h1>
            <p
              style={{
                margin: '7px 0 0',
                fontSize: 'var(--text-base)',
                color: 'var(--text-muted)',
                lineHeight: 1.5,
              }}
            >
              Sign in to the Business Operating System
            </p>
          </div>

          {error && (
            <p
              role="alert"
              style={{
                margin: 0,
                padding: '10px 12px',
                borderRadius: 'var(--radius-md)',
                background: 'var(--status-danger-bg)',
                border: '1px solid var(--status-danger)',
                color: 'var(--status-danger)',
                fontSize: 'var(--text-sm)',
                lineHeight: 1.45,
              }}
            >
              {error}
            </p>
          )}

          {/* Employees — Entra ID / Microsoft 365 work account (PL-032) */}
          <CdButton
            variant="neutral"
            size="lg"
            fullWidth
            shape="square"
            startIcon={MicrosoftGlyph}
            onClick={signInWithMicrosoft}
            disabled={msBusy}
            style={{ fontWeight: 700 }}
          >
            {msBusy ? 'Redirecting…' : 'Sign in with Microsoft'}
          </CdButton>

          {/* divider */}
          <div
            style={{ display: 'flex', alignItems: 'center', gap: 12 }}
            role="separator"
            aria-label="or"
          >
            <span style={{ flex: 1, height: 1, background: 'var(--border-subtle)' }} />
            <span
              style={{
                fontSize: 'var(--text-xs)',
                fontWeight: 600,
                letterSpacing: 'var(--tracking-caps)',
                textTransform: 'uppercase',
                color: 'var(--text-muted)',
              }}
            >
              or
            </span>
            <span style={{ flex: 1, height: 1, background: 'var(--border-subtle)' }} />
          </div>

          {/* Agency & external workers — email a one-time passcode (PL-033/036) */}
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void sendForm.handleSubmit();
            }}
            style={{ display: 'flex', flexDirection: 'column', gap: 14 }}
          >
            <sendForm.Field name="email">
              {(field) => (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  <label
                    htmlFor="signin-email"
                    style={{
                      fontSize: 'var(--text-sm)',
                      fontWeight: 600,
                      color: 'var(--text-body)',
                    }}
                  >
                    Agency or external worker
                  </label>
                  <input
                    id="signin-email"
                    type="email"
                    inputMode="email"
                    autoComplete="email"
                    placeholder="you@company.co.uk"
                    value={field.state.value}
                    onChange={(e) => field.handleChange(e.target.value)}
                    onBlur={field.handleBlur}
                    style={{
                      height: 46,
                      padding: '0 14px',
                      fontFamily: 'var(--font-sans)',
                      fontSize: 'var(--text-base)',
                      color: 'var(--text-strong)',
                      background: 'var(--surface-card)',
                      border: `1.5px solid ${
                        field.state.meta.isTouched && field.state.meta.errors.length
                          ? 'var(--status-danger)'
                          : 'var(--border-default)'
                      }`,
                      borderRadius: 'var(--radius-md)',
                      outline: 'none',
                    }}
                  />
                  {field.state.meta.isTouched && field.state.meta.errors.length ? (
                    <p
                      style={{
                        margin: 0,
                        fontSize: 'var(--text-sm)',
                        color: 'var(--status-danger)',
                      }}
                    >
                      {field.state.meta.errors[0]?.message}
                    </p>
                  ) : null}
                </div>
              )}
            </sendForm.Field>

            {captchaEnabled && siteKey ? (
              <Turnstile ref={turnstileRef} siteKey={siteKey} onToken={setCaptchaToken} />
            ) : null}

            <sendForm.Subscribe
              selector={(s) => ({ canSubmit: s.canSubmit, isSubmitting: s.isSubmitting })}
            >
              {({ canSubmit, isSubmitting }) => (
                <CdButton
                  type="submit"
                  variant="primary"
                  size="lg"
                  fullWidth
                  shape="square"
                  disabled={!canSubmit || isSubmitting}
                  style={{ fontWeight: 700 }}
                >
                  {isSubmitting ? 'Sending…' : 'Email me a sign-in code'}
                </CdButton>
              )}
            </sendForm.Subscribe>
          </form>

          <p
            style={{
              margin: 0,
              fontSize: 'var(--text-xs)',
              color: 'var(--text-muted)',
              lineHeight: 1.55,
              textAlign: 'center',
            }}
          >
            Employees sign in with their Microsoft work account. Agency and external workers use the
            email address their invitation was sent to.
          </p>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
          <OTPEntry email={email} onComplete={verifyOtp} onResend={resendOtp} error={otpError} />
          <button
            type="button"
            onClick={() => {
              setStep('signin');
              setOtpError(null);
            }}
            style={{
              background: 'none',
              border: 'none',
              padding: 0,
              cursor: 'pointer',
              alignSelf: 'center',
              font: '600 var(--text-sm)/1.2 var(--font-sans)',
              color: 'var(--text-link)',
            }}
          >
            Use a different email
          </button>
        </div>
      )}
    </AuthShell>
  );
}
