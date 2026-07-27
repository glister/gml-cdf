import * as React from 'react';

/* Ported from the CD Fencing Design System (components/auth/OTPEntry).
   Segmented six-digit input with auto-advance, backspace-to-previous, paste
   support and a resend countdown. Emits onComplete(code) when full. */

export interface OTPEntryProps {
  email?: string | null;
  length?: number;
  defaultCode?: string;
  onChange?: (code: string) => void;
  onComplete?: (code: string) => void;
  onResend?: () => void;
  resendSeconds?: number;
  error?: null | 'wrong' | 'expired' | string;
  busy?: boolean;
  style?: React.CSSProperties;
}

export function OTPEntry({
  email,
  length = 6,
  defaultCode = '',
  onChange,
  onComplete,
  onResend,
  resendSeconds = 30,
  error = null,
  busy = false,
  style = {},
}: OTPEntryProps) {
  const [digits, setDigits] = React.useState<string[]>(() => {
    const seed = String(defaultCode).replace(/\D/g, '').slice(0, length).split('');
    return Array.from({ length }, (_, i) => seed[i] || '');
  });
  const [left, setLeft] = React.useState(resendSeconds);
  const refs = React.useRef<(HTMLInputElement | null)[]>([]);

  React.useEffect(() => {
    if (left <= 0) return;
    const t = setInterval(() => setLeft((n) => (n <= 1 ? 0 : n - 1)), 1000);
    return () => clearInterval(t);
  }, [left]);

  const emit = (arr: string[]) => {
    const code = arr.join('');
    if (onChange) onChange(code);
    if (code.length === length && arr.every((d) => d !== '') && onComplete) onComplete(code);
  };

  const setAt = (i: number, val: string) => {
    const clean = val.replace(/\D/g, '');
    const next = digits.slice();
    if (clean === '') {
      next[i] = '';
      setDigits(next);
      emit(next);
      return;
    }
    next[i] = clean[clean.length - 1];
    setDigits(next);
    emit(next);
    if (i < length - 1) refs.current[i + 1]?.focus();
  };

  const onKeyDown = (i: number, e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Backspace') {
      if (digits[i]) {
        const n = digits.slice();
        n[i] = '';
        setDigits(n);
        emit(n);
      } else if (i > 0) {
        refs.current[i - 1]?.focus();
        const n = digits.slice();
        n[i - 1] = '';
        setDigits(n);
        emit(n);
      }
    } else if (e.key === 'ArrowLeft' && i > 0) {
      refs.current[i - 1]?.focus();
    } else if (e.key === 'ArrowRight' && i < length - 1) {
      refs.current[i + 1]?.focus();
    }
  };

  const onPaste = (e: React.ClipboardEvent<HTMLDivElement>) => {
    e.preventDefault();
    const text = (e.clipboardData.getData('text') || '').replace(/\D/g, '').slice(0, length);
    if (!text) return;
    const next = Array(length).fill('');
    for (let i = 0; i < text.length; i++) next[i] = text[i];
    setDigits(next);
    emit(next);
    const focusIdx = Math.min(text.length, length - 1);
    refs.current[focusIdx]?.focus();
  };

  const resend = () => {
    if (left > 0 || busy) return;
    if (onResend) onResend();
    setDigits(Array(length).fill(''));
    setLeft(resendSeconds);
    refs.current[0]?.focus();
  };

  const errText =
    error === 'wrong'
      ? 'That code isn’t right. Check the six digits and try again.'
      : error === 'expired'
        ? 'That code has expired. Request a new one below.'
        : error || null;
  const invalid = !!error;

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 22,
        fontFamily: 'var(--font-sans)',
        ...style,
      }}
    >
      <div>
        <h1
          style={{
            margin: 0,
            font: '800 var(--text-xl)/1.1 var(--font-sans)',
            letterSpacing: 'var(--tracking-tight)',
            color: 'var(--text-strong)',
          }}
        >
          Enter your passcode
        </h1>
        <p
          style={{
            margin: '6px 0 0',
            fontSize: 'var(--text-sm)',
            color: 'var(--text-muted)',
            lineHeight: 1.5,
          }}
        >
          We’ve sent a six-digit code to{' '}
          {email ? <strong style={{ color: 'var(--text-body)' }}>{email}</strong> : 'your email'}.
          It expires in 10 minutes.
        </p>
      </div>

      {/* segmented input */}
      <div>
        <div
          style={{ display: 'flex', gap: 'clamp(6px, 2vw, 10px)', justifyContent: 'space-between' }}
          onPaste={onPaste}
        >
          {digits.map((d, i) => (
            <input
              key={i}
              ref={(el) => {
                refs.current[i] = el;
              }}
              type="text"
              inputMode="numeric"
              autoComplete={i === 0 ? 'one-time-code' : 'off'}
              maxLength={1}
              value={d}
              disabled={busy}
              aria-label={`Digit ${i + 1}`}
              onChange={(e) => setAt(i, e.target.value)}
              onKeyDown={(e) => onKeyDown(i, e)}
              onFocus={(e) => e.target.select()}
              style={{
                width: '100%',
                minWidth: 0,
                aspectRatio: '1 / 1',
                maxWidth: 56,
                textAlign: 'center',
                fontFamily: 'var(--font-mono)',
                fontSize: 'var(--text-xl)',
                fontWeight: 600,
                color: 'var(--text-strong)',
                background: busy ? 'var(--gray-100)' : 'var(--surface-card)',
                border: `1.5px solid ${invalid ? 'var(--status-danger)' : d ? 'var(--brand)' : 'var(--border-default)'}`,
                borderRadius: 'var(--radius-md)',
                outline: 'none',
                transition:
                  'border-color var(--duration-fast) var(--ease-standard), box-shadow var(--duration-fast) var(--ease-standard)',
              }}
              onFocusCapture={(e) => {
                if (!invalid) e.currentTarget.style.boxShadow = 'var(--ring)';
              }}
              onBlur={(e) => {
                e.currentTarget.style.boxShadow = 'none';
              }}
            />
          ))}
        </div>
        {errText && (
          <p
            role="alert"
            style={{
              margin: '10px 0 0',
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              fontSize: 'var(--text-sm)',
              color: 'var(--status-danger)',
              fontWeight: 500,
            }}
          >
            <svg
              width="15"
              height="15"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.25"
              strokeLinecap="round"
            >
              <circle cx="12" cy="12" r="9" />
              <path d="M12 8v4M12 16h.01" />
            </svg>
            {errText}
          </p>
        )}
      </div>

      {/* resend */}
      <div style={{ textAlign: 'center', fontSize: 'var(--text-sm)', color: 'var(--text-muted)' }}>
        Didn’t get it?{' '}
        {left > 0 ? (
          <span>
            Resend in{' '}
            <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--text-body)' }}>
              0:{String(left).padStart(2, '0')}
            </span>
          </span>
        ) : (
          <button
            type="button"
            onClick={resend}
            disabled={busy}
            style={{
              background: 'none',
              border: 'none',
              padding: 0,
              cursor: 'pointer',
              font: '600 var(--text-sm)/1 var(--font-sans)',
              color: 'var(--text-link)',
            }}
          >
            Resend code
          </button>
        )}
      </div>
    </div>
  );
}
