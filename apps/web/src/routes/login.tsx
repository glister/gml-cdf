import { useState } from 'react';
import { createFileRoute, useRouter } from '@tanstack/react-router';
import { useForm } from '@tanstack/react-form';
import { z } from 'zod';
import { authClient } from '../auth-client.js';
import { Button } from '../components/ui/button.js';

export const Route = createFileRoute('/login')({
  component: LoginPage,
});

const emailSchema = z.object({ email: z.email('Enter a valid email address') });
const otpSchema = z.object({
  otp: z.string().length(6, 'Enter the 6-digit code'),
});

function LoginPage() {
  const router = useRouter();
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const sendForm = useForm({
    defaultValues: { email: '' },
    validators: { onChange: emailSchema },
    onSubmit: async ({ value }) => {
      setError(null);
      const { error: err } = await authClient.emailOtp.sendVerificationOtp({
        email: value.email,
        type: 'sign-in',
      });
      if (err) setError(err.message ?? 'Failed to send code');
      else setSent(true);
    },
  });

  const verifyForm = useForm({
    defaultValues: { otp: '' },
    validators: { onChange: otpSchema },
    onSubmit: async ({ value }) => {
      setError(null);
      const { error: err } = await authClient.signIn.emailOtp({
        email: sendForm.state.values.email,
        otp: value.otp,
      });
      if (err) {
        setError(err.message ?? 'Invalid code');
        return;
      }
      await router.navigate({ to: '/dashboard' });
    },
  });

  return (
    <main className="mx-auto flex min-h-screen max-w-sm flex-col justify-center gap-4 p-6">
      <h1 className="text-2xl font-semibold">Sign in</h1>
      {error ? <p className="text-sm text-red-600">{error}</p> : null}

      {!sent ? (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void sendForm.handleSubmit();
          }}
          className="flex flex-col gap-3"
        >
          <sendForm.Field name="email">
            {(field) => (
              <>
                <input
                  type="email"
                  placeholder="you@example.com"
                  value={field.state.value}
                  onChange={(e) => field.handleChange(e.target.value)}
                  onBlur={field.handleBlur}
                  className="h-10 rounded-md border border-zinc-300 px-3"
                />
                {field.state.meta.isTouched && field.state.meta.errors.length ? (
                  <p className="text-sm text-red-600">{field.state.meta.errors[0]?.message}</p>
                ) : null}
              </>
            )}
          </sendForm.Field>
          <sendForm.Subscribe
            selector={(s) => ({
              canSubmit: s.canSubmit,
              isSubmitting: s.isSubmitting,
            })}
          >
            {({ canSubmit, isSubmitting }) => (
              <Button type="submit" disabled={!canSubmit}>
                {isSubmitting ? 'Sending…' : 'Send code'}
              </Button>
            )}
          </sendForm.Subscribe>
        </form>
      ) : (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void verifyForm.handleSubmit();
          }}
          className="flex flex-col gap-3"
        >
          <verifyForm.Field name="otp">
            {(field) => (
              <>
                <input
                  inputMode="numeric"
                  placeholder="6-digit code"
                  value={field.state.value}
                  onChange={(e) => field.handleChange(e.target.value)}
                  onBlur={field.handleBlur}
                  className="h-10 rounded-md border border-zinc-300 px-3 tracking-widest"
                />
                {field.state.meta.isTouched && field.state.meta.errors.length ? (
                  <p className="text-sm text-red-600">{field.state.meta.errors[0]?.message}</p>
                ) : null}
              </>
            )}
          </verifyForm.Field>
          <verifyForm.Subscribe
            selector={(s) => ({
              canSubmit: s.canSubmit,
              isSubmitting: s.isSubmitting,
            })}
          >
            {({ canSubmit, isSubmitting }) => (
              <Button type="submit" disabled={!canSubmit}>
                {isSubmitting ? 'Verifying…' : 'Verify'}
              </Button>
            )}
          </verifyForm.Subscribe>
        </form>
      )}
    </main>
  );
}
