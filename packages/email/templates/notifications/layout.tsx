// Templates are consumed as source in dev (the `development` export condition),
// where the consuming app's tsx/esbuild applies its automatic JSX runtime only
// to files in the app's own tsconfig scope. These out-of-scope templates fall
// back to esbuild's default classic transform (`React.createElement`), so every
// template MUST import React to provide that binding — otherwise it throws
// "React is not defined" at runtime. Convention: React is the first import.
import React from 'react';
import type { CSSProperties, ReactNode } from 'react';
import {
  Body,
  Button,
  Container,
  Head,
  Heading,
  Html,
  Preview,
  Text,
} from '@react-email/components';

/**
 * The shared frame every notification email renders into (core plan 10 §5.4).
 *
 * One layout rather than one design per kind, and that is a content decision as
 * much as a code one: a chase and a task assignment should look identical,
 * because the moment a kind gets its own richer template is the moment someone
 * adds a detail line to it. The frame gives a title, a short body and a single
 * link back into the app — and the app is where anything sensitive lives, behind
 * its own authorisation (SA-023, §4.6).
 */

export interface NotificationEmailProps {
  title: string;
  body: string;
  /** Absolute URL — built by the sender from the app base plus `action_url`. */
  actionUrl?: string | null;
  actionLabel?: string;
  /** Rendered under the button; kept for kinds that want one extra line. */
  footer?: ReactNode;
}

export function NotificationEmail({
  title,
  body,
  actionUrl,
  actionLabel = 'Open in CD Fencing',
  footer,
}: NotificationEmailProps) {
  return (
    <Html>
      <Head />
      {/* The inbox preview line. Deliberately the same generic title rather
          than the first words of the body — a phone lock screen is the least
          controlled surface any of this content reaches. */}
      <Preview>{title}</Preview>
      <Body style={main}>
        <Container style={container}>
          <Heading style={heading}>{title}</Heading>
          <Text style={paragraph}>{body}</Text>
          {actionUrl ? (
            <Button href={actionUrl} style={button}>
              {actionLabel}
            </Button>
          ) : null}
          {footer ? <Text style={muted}>{footer}</Text> : null}
          <Text style={muted}>
            You are receiving this because of a role you hold in CD Fencing. Notification recipients
            are resolved by role, so this will follow your role rather than your name.
          </Text>
        </Container>
      </Body>
    </Html>
  );
}

export default NotificationEmail;

const main: CSSProperties = {
  backgroundColor: '#f4f4f5',
  fontFamily: 'ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, sans-serif',
};
const container: CSSProperties = {
  margin: '0 auto',
  padding: '32px',
  maxWidth: '480px',
};
const heading: CSSProperties = { fontSize: '20px', fontWeight: 600, color: '#18181b' };
const paragraph: CSSProperties = { fontSize: '14px', color: '#3f3f46', lineHeight: '22px' };
const button: CSSProperties = {
  display: 'inline-block',
  padding: '10px 18px',
  borderRadius: '8px',
  backgroundColor: '#18181b',
  color: '#ffffff',
  fontSize: '14px',
  fontWeight: 600,
  textDecoration: 'none',
};
const muted: CSSProperties = { fontSize: '12px', color: '#a1a1aa', lineHeight: '18px' };
