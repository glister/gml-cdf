import * as React from 'react';
import { createFileRoute, useRouter } from '@tanstack/react-router';
import { useForm } from '@tanstack/react-form';
import { z } from 'zod';
import { authClient } from '../auth-client.js';
import { clientEnv } from '../env.js';
import { AuthShell } from '../components/auth/AuthShell.js';
import { OTPEntry } from '../components/auth/OTPEntry.js';
import { Turnstile, type TurnstileHandle } from '../components/auth/Turnstile.js';
import { Button } from '../components/ui/button.js';
import { cn } from '../lib/utils.js';

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
        <div className="flex flex-col gap-[22px] font-sans">
          <div>
            <h1 className="text-xl font-extrabold leading-[1.15] tracking-tight text-strong">
              Welcome to Connect
            </h1>
            <p className="mt-[7px] text-base leading-normal text-muted">
              Sign in to the Business Operating System
            </p>
          </div>

          {error && (
            <p
              role="alert"
              className="rounded-md border border-status-danger bg-status-danger-bg px-3 py-2.5 text-sm leading-snug text-status-danger"
            >
              {error}
            </p>
          )}

          {/* Employees — Entra ID / Microsoft 365 work account (PL-032) */}
          <Button
            variant="neutral"
            size="lg"
            shape="square"
            fullWidth
            startIcon={MicrosoftGlyph}
            onClick={signInWithMicrosoft}
            disabled={msBusy}
          >
            {msBusy ? 'Redirecting…' : 'Sign in with Microsoft'}
          </Button>

          {/* divider */}
          <div className="flex items-center gap-3" role="separator" aria-label="or">
            <span className="h-px flex-1 bg-border-subtle" />
            <span className="text-xs font-semibold uppercase tracking-caps text-muted">or</span>
            <span className="h-px flex-1 bg-border-subtle" />
          </div>

          {/* Agency & external workers — email a one-time passcode (PL-033/036) */}
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void sendForm.handleSubmit();
            }}
            className="flex flex-col gap-3.5"
          >
            <sendForm.Field name="email">
              {(field) => {
                const invalid = field.state.meta.isTouched && field.state.meta.errors.length > 0;
                return (
                  <div className="flex flex-col gap-1.5">
                    <label htmlFor="signin-email" className="text-sm font-semibold text-body">
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
                      className={cn(
                        'h-[46px] rounded-md border-[1.5px] bg-surface-card px-3.5 text-base text-strong outline-none focus-visible:ring-2 focus-visible:ring-brand/40',
                        invalid ? 'border-status-danger' : 'border-border-default',
                      )}
                    />
                    {invalid ? (
                      <p className="text-sm text-status-danger">
                        {field.state.meta.errors[0]?.message}
                      </p>
                    ) : null}
                  </div>
                );
              }}
            </sendForm.Field>

            {captchaEnabled && siteKey ? (
              <Turnstile ref={turnstileRef} siteKey={siteKey} onToken={setCaptchaToken} />
            ) : null}

            <sendForm.Subscribe
              selector={(s) => ({ canSubmit: s.canSubmit, isSubmitting: s.isSubmitting })}
            >
              {({ canSubmit, isSubmitting }) => (
                <Button
                  type="submit"
                  variant="primary"
                  size="lg"
                  shape="square"
                  fullWidth
                  disabled={!canSubmit || isSubmitting}
                >
                  {isSubmitting ? 'Sending…' : 'Email me a sign-in code'}
                </Button>
              )}
            </sendForm.Subscribe>
          </form>

          <p className="text-center text-xs leading-[1.55] text-muted">
            Employees sign in with their Microsoft work account. Agency and external workers use the
            email address their invitation was sent to.
          </p>
        </div>
      ) : (
        <div className="flex flex-col gap-5">
          <OTPEntry email={email} onComplete={verifyOtp} onResend={resendOtp} error={otpError} />
          <button
            type="button"
            onClick={() => {
              setStep('signin');
              setOtpError(null);
            }}
            className="self-center font-sans text-sm font-semibold text-link"
          >
            Use a different email
          </button>
        </div>
      )}
    </AuthShell>
  );
}
